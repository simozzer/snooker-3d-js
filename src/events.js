// events.js — analytic event detection over two-phase (slide→roll) trajectories.
//
// Every ball's path is a list of polynomial segments in absolute time (motion.segments):
// position = P + V·t + C·t² on (lo, hi]. Within a single segment the coefficients are
// constant, so each event type reduces to a closed-form polynomial solve — run once per segment
// (and, for pairs, once per overlapping segment×segment window). Each detector finds the first
// DOWNWARD crossing of its gap (approaching), so a ball resting against / separating from a wall
// or pair is not re-detected:
//   wall   — per-axis quadratic gap          → firstApproachQuad
//   pair   — |Δp(t)|² − R² ⇒ quartic gap      → firstApproachInWindow
//   pocket — quartic vs a fixed circle        → contactInWindow → firstQuarticRoot
//
// All times returned are ABSOLUTE; callers pass tNow as the lower bound for a valid event.

import * as v from './vec2.js';
import * as v3 from './vec3.js';
import { firstQuarticRoot, cubicRoots, firstRoot } from './roots.js';
import { posAt, segments, segmentsToHorizon, PHASE } from './motion.js';
import { GRAVITY, POCKET_SLOW_DROP, POCKET_DROP_R2 } from './snooker.js';

const TIME_EPS = 1e-9;
const CONTACT_EPS = 1e-7; // metres: treat as already-touching
const BISECT_TOL = 1e-10;

// First t in (lo, hi] where the quadratic g(t) = a2 t² + a1 t + a0 crosses DOWNWARD (from > 0
// to ≤ 0). Used for cushions with g = signed gap to the wall: this catches the ball reaching
// the cushion while moving TOWARD it, and skips a ball sitting on a cushion moving away (or a
// spin-curved path that would otherwise tunnel straight back through), the wall analog of
// firstApproachInWindow for pairs.
function firstApproachQuad(a2, a1, a0, lo, hi) {
  if (hi <= lo + TIME_EPS) return Infinity;
  const g = (t) => (a2 * t + a1) * t + a0;
  const crit = Math.abs(a2) > 1e-15 ? -a1 / (2 * a2) : Infinity; // single extremum of a parabola
  const pts = crit > lo && crit < hi ? [lo, crit, hi] : [lo, hi];
  for (let i = 0; i < pts.length - 1; i++) {
    const x0 = pts[i];
    const x1 = pts[i + 1];
    if (g(x0) > 0 && g(x1) <= 0) {
      let a = x0;
      let b = x1;
      while (b - a > BISECT_TOL) {
        const m = 0.5 * (a + b);
        if (g(m) <= 0) b = m;
        else a = m;
      }
      return 0.5 * (a + b);
    }
  }
  return Infinity;
}

// First t in (lo, hi] where |A + B t + C t²| = R (the contact quartic), or Infinity.
function contactInWindow(A, B, C, R, lo, hi) {
  if (hi <= lo + TIME_EPS) return Infinity;
  const k4 = v.dot(C, C);
  const k3 = 2 * v.dot(B, C);
  const k2 = v.dot(B, B) + 2 * v.dot(A, C);
  const k1 = 2 * v.dot(A, B);
  const k0 = v.dot(A, A) - R * R;
  const t = firstQuarticRoot(k4, k3, k2, k1, k0, lo, hi);
  return t > lo && t < Infinity ? t : Infinity;
}

// First t in (lo, hi] where the gap g(t) = |A + B t + C t²|² − R² crosses DOWNWARD (from > 0
// to ≤ 0) — i.e. the balls are touching while APPROACHING. Crucially this skips a separating
// crossing (a pair that just resolved is moving apart, g rising), so we never re-detect the
// contact we just resolved, yet we still catch a later re-approach along the same trajectories
// (which the old "touching ⇒ Infinity" guard wrongly discarded, letting slow pairs tunnel).
// A/B/C are 3-vectors (the difference of two 3D motion segments), so the gap |Δp|² includes the
// z term — a ball hopping ONTO another is a real 3D approach, not just a horizontal-shadow one.
// On the flat table Δz ≡ 0 so the z contribution vanishes and this equals the 2D quartic exactly.
function firstApproachInWindow(A, B, C, R, lo, hi) {
  if (hi <= lo + TIME_EPS) return Infinity;
  const k4 = v3.dot(C, C);
  const k3 = 2 * v3.dot(B, C);
  const k2 = v3.dot(B, B) + 2 * v3.dot(A, C);
  const k1 = 2 * v3.dot(A, B);
  const k0 = v3.dot(A, A) - R * R;
  const q = (t) => (((k4 * t + k3) * t + k2) * t + k1) * t + k0;
  // monotonic sub-intervals are bounded by the quartic's critical points (roots of q')
  const crit = cubicRoots(4 * k4, 3 * k3, 2 * k2, k1).filter((t) => t > lo && t < hi).sort((x, y) => x - y);
  const pts = [lo, ...crit, hi];
  for (let i = 0; i < pts.length - 1; i++) {
    let x0 = pts[i];
    const x1 = pts[i + 1];
    if (q(x0) > 0 && q(x1) <= 0) {
      let a = x0;
      let b = x1;
      while (b - a > BISECT_TOL) {
        const m = 0.5 * (a + b);
        if (q(m) <= 0) b = m;
        else a = m;
      }
      return 0.5 * (a + b);
    }
  }
  return Infinity;
}

// Earliest cushion contact for a ball against axis-aligned bounds. { time, axis } or null.
//
// Each cushion is found as the first DOWNWARD crossing of its signed gap g(t) (positive inside
// the table, 0 at contact). This catches the ball arriving at the cushion while moving toward
// it, and inherently skips a cushion the ball is resting against / separating from — so a
// spin-curved slide can't tunnel back through a wall it just left (which let balls escape).
export function detectWall(ball, bounds, tNow) {
  const r = ball.radius;
  const xMin = bounds.minX + r;
  const xMax = bounds.maxX - r;
  const yMin = bounds.minY + r;
  const yMax = bounds.maxY - r;
  let best = Infinity;
  let axis = null;
  for (const s of segments(ball.plan, ball.t0)) {
    const lo = Math.max(s.lo, tNow);
    if (lo >= s.hi) continue;
    // gap to each wall as a quadratic a2 t² + a1 t + a0 (positive while inside the table):
    const consider = (a2, a1, a0, ax) => {
      const t = firstApproachQuad(a2, a1, a0, lo, s.hi);
      if (t < best) { best = t; axis = ax; }
    };
    consider(s.C.x, s.V.x, s.P.x - xMin, 'x'); // left:   x − xMin
    consider(-s.C.x, -s.V.x, xMax - s.P.x, 'x'); // right:  xMax − x
    consider(s.C.y, s.V.y, s.P.y - yMin, 'y'); // bottom: y − yMin
    consider(-s.C.y, -s.V.y, yMax - s.P.y, 'y'); // top:    yMax − y
  }
  return axis ? { time: best, axis } : null;
}

// Earliest FRAME backstop contact for a ball, or { time, axis }. The frame is the physical table
// edge (|x|=maxX / |y|=maxY, ball centre at edge∓R) treated as a plain reflective wall — a
// belt-and-braces catch for anything the rails/jaws/pockets miss (e.g. a ball rolling parallel to a
// rail just inside it, threading a corner pocket-gap where neither rail covers). It fires ONLY when
// the ball is below the cushion top (a high ball has already cleared) AND NOT within a pocket
// MOUTH (so a genuine pot is never blocked). Below the rail contact line in open play the rail
// fires first, so the frame only ever bites an escapee. Reuses the wall quadratic — no new solver.
export function detectFrame(ball, bnds, pcks, topZ, tNow) {
  const R = ball.radius;
  const xMin = bnds.minX + R;
  const xMax = bnds.maxX - R;
  const yMin = bnds.minY + R;
  const yMax = bnds.maxY - R;
  let best = Infinity;
  let axis = null;
  // Defer to a genuine pot: if the ball reaches a pocket THROAT at or before the frame crossing, the
  // pocket captures it — skip the frame there (even though the frame line, only R inside the edge,
  // is crossed first for a deep corner pot). A runner that never reaches a throat before the edge is
  // still framed. Comparing the throat time to the frame time (not just "reaches a throat somewhere
  // in the segment") is essential: a ball can cross the edge and tunnel BEFORE later nearing a
  // throat, so a whole-segment test would wrongly suppress the frame and let it escape.
  const throatTime = (s, lo, hi) => {
    let tt = Infinity;
    for (const p of pcks) {
      const A = v.sub(s.P, p.center);
      const th = contactInWindow(A, s.V, s.C, p.radius, lo, hi);
      if (th < tt) tt = th;
    }
    return tt;
  };
  for (const s of segments(ball.plan, ball.t0)) {
    const lo = Math.max(s.lo, tNow);
    if (lo >= s.hi) continue;
    const tThroat = throatTime(s, lo, s.hi);
    const consider = (a2, a1, a0, ax) => {
      const t = firstApproachQuad(a2, a1, a0, lo, s.hi);
      if (t >= best || t === Infinity) return;
      const zAt = s.P.z + s.V.z * t + s.C.z * t * t;
      if (zAt > topZ) return; // above the cushion → cleared, not framed
      if (tThroat <= t + TIME_EPS) return; // a pocket capture comes first → let the pocket handle it
      best = t; axis = ax;
    };
    consider(s.C.x, s.V.x, s.P.x - xMin, 'x'); // left
    consider(-s.C.x, -s.V.x, xMax - s.P.x, 'x'); // right
    consider(s.C.y, s.V.y, s.P.y - yMin, 'y'); // bottom
    consider(-s.C.y, -s.V.y, yMax - s.P.y, 'y'); // top
  }
  return axis ? { time: best, axis } : null;
}

// Earliest cushion-cylinder (rail) contact for a ball. { time, rail } or null.
//
// Each straight rail is a horizontal cylinder (table.railCylinders). The exact cylinder contact is
//   dist²(centre(t), axis-line) − (R + r_c)² = 0,  dist dropping the ALONG-AXIS component,
// which for a rail along x is (y(t)−perp)² + (z(t)−z_axis)² = (R+r_c)² — degree ≤2 per axis, so a
// QUARTIC, solved by the same firstApproachInWindow used for ball-ball (fed a perpendicular-plane
// 2-vector). That is the analytic rail-hop condition. We ALSO solve the HORIZONTAL perpendicular
// approach |perp(t)−face| = R (a quadratic via firstApproachQuad) and take whichever fires first:
// the two coincide for a bed-height ball (contact at |Δperp|=R, exactly the flat-wall stop), but
// for a ball contacting the rail slightly AIRBORNE the cylinder would let its centre ride a hair
// deeper (a below-centre nose is reached later horizontally when the ball is high); the horizontal
// guard caps that so the centre never crosses the flat-wall line — no tunnelling, wall-equivalent
// positioning. Both are existing solvers (no new one). First DOWNWARD (approaching) crossing only,
// so a resting/leaving rail isn't re-detected. Finite rail: contact must lie within the along-axis
// span (pocket mouths are gaps).
export function detectRail(ball, rails, tNow, topZ = Infinity) {
  const R = ball.radius;
  let best = Infinity;
  let hitRail = null;
  for (const s of segments(ball.plan, ball.t0)) {
    const lo = Math.max(s.lo, tNow);
    if (lo >= s.hi) continue;
    for (const rail of rails) {
      const along = rail.axis === 'x' ? 'x' : 'y';
      const perpAx = rail.axis === 'x' ? 'y' : 'x';
      // (1) exact cylinder quartic (perpendicular-plane distance, along-axis component zeroed):
      const A = perpAx === 'y'
        ? v3.vec(0, s.P.y - rail.perp, s.P.z - rail.z)
        : v3.vec(s.P.x - rail.perp, 0, s.P.z - rail.z);
      const B = perpAx === 'y' ? v3.vec(0, s.V.y, s.V.z) : v3.vec(s.V.x, 0, s.V.z);
      const C = perpAx === 'y' ? v3.vec(0, s.C.y, s.C.z) : v3.vec(s.C.x, 0, s.C.z);
      const tCyl = firstApproachInWindow(A, B, C, R + rail.rc, lo, s.hi);
      // (2) horizontal-perp quadratic guard: |perp − face| = R, signed so the interior gap > 0.
      const g0 = rail.perpSign * (rail.perp - s.P[perpAx]) - R; // gap = perpSign(perp − p) − R
      const g1 = rail.perpSign * -s.V[perpAx];
      const g2 = rail.perpSign * -s.C[perpAx];
      const tFlat = firstApproachQuad(g2, g1, g0, lo, s.hi);
      const t = Math.min(tCyl, tFlat);
      if (t >= best || t === Infinity) continue;
      // finite rail: the contact must fall within the rail's along-axis span (pocket gaps excluded)
      const aPos = s.P[along] + s.V[along] * t + s.C[along] * t * t;
      if (aPos < rail.span[0] || aPos > rail.span[1]) continue;
      // finite HEIGHT: a ball whose centre is above the cushion top clears the rail (Milestone C2).
      const zAt = s.P.z + s.V.z * t + s.C.z * t * t;
      if (zAt > topZ) continue;
      best = t;
      hitRail = rail;
    }
  }
  return hitRail ? { time: best, rail: hitRail } : null;
}

// Earliest pocket-JAW (torus) contact for a ball, or null. { time, jaw }. The jaw is a rounded
// rail-end torus (table.pocketJaws); the ball-vs-torus gap
//   f(t) = sqrt( (hypot(x−cx, y−cy) − Rring)² + (z−zc)² ) − (R + tube)
// is NON-POLYNOMIAL (a sqrt of a sqrt), so there is no closed-form root — this is the case the
// sampled roots.firstRoot was reserved for. We march f over the ball's remaining trajectory,
// graze-seeded at each step's local minimum so a brief clip of a jaw isn't skipped. topZ caps the
// search to the finite cushion height: a ball whose centre is above the cushion clears the jaws.
export function detectJaw(ball, jaws, tNow, topZ) {
  const R = ball.radius;
  const plan = ball.plan;
  const planEnd = ball.t0 + plan.tStop;
  const lo = Math.max(tNow, ball.t0);
  if (planEnd <= lo + TIME_EPS) return null;
  // Broad-phase OVER-estimate of remaining centre travel — reuse the vetted reachBound (handles the
  // slide→roll speed-up and swerve, which a plain |v|·dt would under-estimate and wrongly prune).
  const now = posAt(plan, tNow - ball.t0);
  const travel = reachBound(ball, tNow);
  let best = Infinity;
  let hitJaw = null;
  for (const jaw of jaws) {
    const reach = R + jaw.tube + jaw.Rring; // outer reach of the torus from its centre
    const dNow = Math.hypot(now.x - jaw.cx, now.y - jaw.cy);
    if (dNow > reach + travel) continue; // broad-phase prune (never discards a reachable jaw)
    // Bound the SAMPLED window to when the ball can actually be near this jaw: the centre is within
    // `reach` of the jaw axis only over a short sub-interval, so sampling that instead of the whole
    // (multi-second) roll keeps the step spacing far below the tiny jaw — no missed graze (fix 1a).
    const speed = Math.max(v3.len(ball.vel), 1e-6);
    const margin = (reach + 3 * R) / speed; // time to cross the reach zone at the current speed
    const winHi = Math.min(planEnd, tNow + (dNow <= reach ? margin : (dNow - reach) / speed + margin) + 0.02);
    const f = (tt) => {
      const p = posAt(plan, tNow + tt - ball.t0);
      if (p.z > topZ) return reach; // above the cushion → clears the jaws (kept positive, no crossing)
      const rho = Math.hypot(p.x - jaw.cx, p.y - jaw.cy);
      return Math.hypot(rho - jaw.Rring, p.z - jaw.z) - (R + jaw.tube);
    };
    // Downward-crossing only: if the ball is currently INSIDE the torus (just-resolved, still
    // penetrating) it is separating — advance past the penetration until f>0 (exit), then search the
    // next genuine approach. This never re-detects the resolved contact regardless of penetration
    // depth (the old fixed 1e-6 skip could not clear a ~5 mm penetration and re-fired → Zeno). (fix 6)
    let start = 0;
    if (f(0) <= 0) {
      // Step OUT of the current penetration at a rate tied to how fast the ball is separating: the
      // exit takes ~ (penetration depth)/speed, so a step of tube/speed clears any plausible
      // penetration in O(1) iterations regardless of the window length (a fast ball on a long roll
      // no longer walks 1e-4 at a time for 10 s). Iteration-capped as a hard backstop.
      const dts = Math.max((jaw.tube + R) / (4 * speed), 1e-5);
      let iter = 0;
      while (start < winHi - tNow && f(start) <= 0 && iter < 4096) { start += dts; iter += 1; }
      if (start >= winHi - tNow || f(start) <= 0) continue; // never exits within the window
    }
    const win = winHi - tNow - start;
    if (win <= TIME_EPS) continue;
    // CHEAP EXACT pre-filter: the torus lies within `reach` of its axis in every direction, so a
    // contact (f<=0) requires the ball's HORIZONTAL centre distance to the axis to dip to <= reach.
    // That horizontal distance is a polynomial (dist² is a quartic over each motion segment), whose
    // minimum over the window is found in closed form (endpoints + cubicRoots of its derivative) —
    // no sampling. If the min stays above reach, skip the (2048-sample) firstRoot entirely. Exact ⇒
    // it can never discard a real contact, so results are byte-identical to the unfiltered march.
    if (minHorizDist2(plan, ball.t0, jaw.cx, jaw.cy, tNow + start, winHi) > reach * reach) continue;
    const tRel = firstRoot((tt) => f(tt + start), win);
    if (!Number.isFinite(tRel)) continue;
    const t = tNow + start + tRel;
    if (t > lo + TIME_EPS && t < best) { best = t; hitJaw = jaw; }
  }
  return hitJaw ? { time: best, jaw: hitJaw } : null;
}

// Minimum squared horizontal distance from the ball centre to the point (cx,cy) over [t0Abs,t1Abs],
// in ABSOLUTE time. Per motion segment the centre is P+V·t+C·t² (per axis), so d²(t) is a quartic;
// its minimum on the interval is at an endpoint or a real root of d²'(t) (a cubic → cubicRoots).
// Exact — used only as a cheap gate before the sampled torus march.
function minHorizDist2(plan, t0, cx, cy, t0Abs, t1Abs) {
  let mn = Infinity;
  const d2 = (P, V, Cc, t) => {
    const x = P.x + V.x * t + Cc.x * t * t - cx;
    const y = P.y + V.y * t + Cc.y * t * t - cy;
    return x * x + y * y;
  };
  for (const s of segments(plan, t0)) {
    const lo = Math.max(s.lo, t0Abs);
    const hi = Math.min(s.hi, t1Abs);
    if (lo >= hi) continue;
    mn = Math.min(mn, d2(s.P, s.V, s.C, lo), d2(s.P, s.V, s.C, hi));
    // d²'(t)=0: 4(Cx²+Cy²)t³ + 6(VxCx+VyCy)t² + [2(Vx²+Vy²)+4(PxΔ Cx+PyΔ Cy)]t + 2(PxΔVx+PyΔVy)
    const ax = s.P.x - cx;
    const ay = s.P.y - cy;
    const a3 = 4 * (s.C.x * s.C.x + s.C.y * s.C.y);
    const a2 = 6 * (s.V.x * s.C.x + s.V.y * s.C.y);
    const a1 = 2 * (s.V.x * s.V.x + s.V.y * s.V.y) + 4 * (ax * s.C.x + ay * s.C.y);
    const a0 = 2 * (ax * s.V.x + ay * s.V.y);
    for (const t of cubicRoots(a3, a2, a1, a0)) {
      if (t > lo && t < hi) mn = Math.min(mn, d2(s.P, s.V, s.C, t));
    }
  }
  return mn;
}

// Earliest time an AIRBORNE ball CLEARS the table: its centre reaches the RAIL-CONTACT line (the
// table edge offset inward by R — the same line detectRail uses) while its centre is above the
// cushion top, so it flew over the cushion and leaves play (lands on the rail top / floor). Using
// the rail-contact line (not the physical edge) is deliberate: exactly when detectRail declines a
// contact because z>topZ, detectCleared picks the ball up at the SAME line — no slip-through band
// where a ball is too high to rail yet too low to clear. { time } or null. FLIGHT balls only.
export function detectCleared(ball, bnds, topZ, tNow) {
  if (ball.plan.phase !== PHASE.FLIGHT) return null;
  const R = ball.radius;
  let best = Infinity;
  for (const s of segments(ball.plan, ball.t0)) {
    const lo = Math.max(s.lo, tNow);
    if (lo >= s.hi) continue;
    // rail-contact lines: centre reaches (edge − R) on the way out; x,y are LINEAR in flight.
    const lines = [
      [s.P.x, s.V.x, bnds.maxX - R], [s.P.x, s.V.x, bnds.minX + R],
      [s.P.y, s.V.y, bnds.maxY - R], [s.P.y, s.V.y, bnds.minY + R],
    ];
    for (const [P0, V0, line] of lines) {
      if (Math.abs(V0) < 1e-12) continue;
      const t = (line - P0) / V0;
      if (t <= lo + TIME_EPS || t > s.hi || t >= best) continue;
      const zAt = s.P.z + s.V.z * t + s.C.z * t * t;
      if (zAt > topZ) best = t; // above the cushion at the rail line → cleared
    }
  }
  return best < Infinity ? { time: best } : null;
}

// Safe upper bound on how far a ball's CENTRE can travel (in 3D) from its position at tNow until
// it rests / lands. OVER-estimate, so the broad-phase prunes (detectPair, detectJaw) never discard
// a real contact — including screw/swerve curves (where the post-slide roll speed exceeds the
// current slide speed) and airborne arcs. Internal to this module (both callers live here).
function reachBound(ball, tNow) {
  const plan = ball.plan;
  const tL = tNow - ball.t0; // local plan time
  if (tL >= plan.tStop) return 0;
  const dt = plan.tStop - tL;
  if (plan.phase === PHASE.FLIGHT) {
    // horizontal is linear (≤ |v|·dt); vertical adds at most the free-fall extent ½ g dt².
    return v3.len(ball.vel) * dt + 0.5 * GRAVITY * dt * dt;
  }
  const vRollMag = v.len(plan.vRoll);
  if (tL < plan.tRoll) {
    const slide = Math.max(v.len(ball.vel), vRollMag) * (plan.tRoll - tL);
    return slide + vRollMag * (plan.tStop - plan.tRoll);
  }
  return v.len(ball.vel) * dt;
}

// Earliest contact time between two balls (absolute), or Infinity.
export function detectPair(a, b, tNow) {
  const R = a.radius + b.radius;

  // Currently in contact AND approaching → resolve immediately. Otherwise fall through: the
  // downward-crossing search below skips the (separating) contact we may be sitting on and
  // finds the next genuine approach, so a just-resolved pair isn't re-detected at dt~0.
  const dp = v3.sub(a.pos, b.pos);
  const gap = v3.len(dp);
  if (gap - R <= CONTACT_EPS) {
    const vn = v3.dot(v3.sub(a.vel, b.vel), v3.normalize(dp));
    if (vn < 0) return tNow + TIME_EPS;
  }

  // Broad-phase: if neither centre can travel far enough for the gap to close to contact, skip
  // the (expensive) per-segment quartic search entirely. Conservative bound ⇒ no missed contacts.
  if (gap - R > reachBound(a, tNow) + reachBound(b, tNow)) return Infinity;

  const horizon = Math.max(a.t0 + a.plan.tStop, b.t0 + b.plan.tStop);
  if (horizon <= tNow) return Infinity;
  const segA = segmentsToHorizon(a, tNow, horizon);
  const segB = segmentsToHorizon(b, tNow, horizon);

  let best = Infinity;
  for (const sa of segA) {
    for (const sb of segB) {
      const lo = Math.max(sa.lo, sb.lo, tNow);
      const hi = Math.min(sa.hi, sb.hi);
      if (lo >= hi) continue;
      const A = v3.sub(sa.P, sb.P);
      const B = v3.sub(sa.V, sb.V);
      const C = v3.sub(sa.C, sb.C);
      const t = firstApproachInWindow(A, B, C, R, lo, hi);
      if (t < best) best = t;
    }
  }
  return best;
}

// Horizontal velocity at absolute time t from the ball's plan (segments store pos = P + V t + C t²).
function horizVelAt(ball, t) {
  for (const s of segments(ball.plan, ball.t0)) {
    if (t >= s.lo && t <= s.hi) return { x: s.V.x + 2 * s.C.x * t, y: s.V.y + 2 * s.C.y * t };
  }
  return { x: 0, y: 0 }; // past tStop → at rest
}
// Classify a ball reaching a pocket throat: 'drop' (pot), 'rebound' (rattle back into play), or 'skip'
// (not entering — pass on). It DROPS if slow or its line converges on the centre; otherwise, if it's
// heading OUTWARD (toward the mouth/edge) it must REBOUND so it can't tunnel the gap; a fast ball merely
// grazing tangentially (not heading out) is left to pass — it stays in bounds and the rail resumes past
// the gap. (ax,ay) = ball position relative to pocket centre; (vx,vy) = its velocity.
function classifyPocket(ax, ay, vx, vy, center) {
  // Only MIDDLE pockets (centre on a long rail, x=0) can be skimmed PAST along the rail, and their
  // opening normal is the pure rail normal (0,±1) so a rebound fully reverses edge-ward motion. CORNERS
  // are terminal — a ball either heads in or can't reach them — so they always capture (keeping capture
  // the catch-all there means a rejected ball can never escape the table end).
  if (Math.abs(center.x) >= 1e-9) return 'drop';
  const speed2 = vx * vx + vy * vy;
  if (speed2 <= POCKET_SLOW_DROP * POCKET_SLOW_DROP) return 'drop'; // slow → dribbles in
  const dot = ax * vx + ay * vy;
  const perp2 = Math.max(0, ax * ax + ay * ay - (dot * dot) / speed2); // squared perpendicular line-to-centre distance
  if (perp2 <= POCKET_DROP_R2) return 'drop'; // trajectory converges on the pocket → pot
  const nl = Math.hypot(center.x, center.y) || 1;
  const vn = (vx * center.x + vy * center.y) / nl; // velocity component along the outward opening direction
  return vn > 1e-6 ? 'rebound' : 'skip'; // heading out → rattle back; skimming tangentially → pass on
}

// Earliest pocket EVENT for a ball: { time, pocketIndex, rebound } or null. `rebound=false` is a
// capture (pot), `rebound=true` a rattle back into play. 3D-honest: only fires at/below the lip `lipZ`
// (a ball sailing high over the mouth clears it). See classifyPocket for the drop/rebound/skip logic.
export function detectPocket(ball, pocketList, tNow, lipZ = Infinity) {
  for (let p = 0; p < pocketList.length; p++) {
    const pk = pocketList[p];
    if (v.len(v.sub(ball.pos, pk.center)) <= pk.radius && ball.pos.z <= lipZ) {
      const vel = horizVelAt(ball, tNow);
      const c = classifyPocket(ball.pos.x - pk.center.x, ball.pos.y - pk.center.y, vel.x, vel.y, pk.center);
      if (c !== 'skip') return { time: tNow + TIME_EPS, pocketIndex: p, rebound: c === 'rebound' };
    }
  }
  let best = Infinity;
  let idx = -1;
  let reb = false;
  for (const s of segments(ball.plan, ball.t0)) {
    const lo = Math.max(s.lo, tNow);
    if (lo >= s.hi) continue;
    for (let p = 0; p < pocketList.length; p++) {
      const pk = pocketList[p];
      const A = v.sub(s.P, pk.center);
      const t = contactInWindow(A, s.V, s.C, pk.radius, lo, s.hi);
      if (t >= best) continue;
      const zAt = s.P.z + s.V.z * t + s.C.z * t * t; // ball-centre height at the mouth crossing
      if (zAt > lipZ) continue; // sailing over the mouth — not captured, it clears
      const px = s.P.x + s.V.x * t + s.C.x * t * t;
      const py = s.P.y + s.V.y * t + s.C.y * t * t;
      const vx = s.V.x + 2 * s.C.x * t;
      const vy = s.V.y + 2 * s.C.y * t;
      const c = classifyPocket(px - pk.center.x, py - pk.center.y, vx, vy, pk.center);
      if (c === 'skip') continue;
      best = t;
      idx = p;
      reb = c === 'rebound';
    }
  }
  return idx >= 0 ? { time: best, pocketIndex: idx, rebound: reb } : null;
}

// Earliest bed (z = R plane) contact for an AIRBORNE ball, or null. The FLIGHT segment's z-track
// is z(t) = Pz + Vz t + Cz t² (Cz = ½g < 0), so the height gap g(t) = z(t) − R is a downward-
// opening QUADRATIC — the ball-vs-bed contact is a plain quadratic root (no quartic needed).
//
// We solve g(t)=0 analytically and take the DESCENDING root (g′(t) = 2 Cz t + Vz ≤ 0, the ball
// falling back onto the bed) strictly after `lo`. Solving the roots directly — rather than a
// sign-bracketed bisection — is robust for the tiny end-of-settle micro-flights that launch from
// exactly z=R: there g(lo)=0 to floating-point noise, and an endpoint sign test would flap and
// miss the landing (which stalled multi-bounce settling). The ascending root at ≈lo (the launch
// we just resolved) is excluded by the g′≤0 filter, so a bounce is never re-detected at dt~0.
// { time } or null.
export function detectBed(ball, tNow) {
  const R = ball.radius;
  let best = Infinity;
  for (const s of segments(ball.plan, ball.t0)) {
    const lo = Math.max(s.lo, tNow);
    if (lo >= s.hi) continue;
    const a2 = s.C.z;
    const a1 = s.V.z;
    const a0 = s.P.z - R;
    // On-table segments have a2=a1=0 (z pinned at R) → not a flight arc; skip cleanly.
    if (Math.abs(a2) < 1e-15) continue;
    const disc = a1 * a1 - 4 * a2 * a0;
    if (disc < 0) continue; // never reaches the bed within this arc
    const sq = Math.sqrt(disc);
    // Upper bound is s.hi + TIME_EPS: for a flight arc s.hi IS the analytic landing (plan.tStop),
    // so the descending root equals hi to within floating-point noise — a strict `t > s.hi` reject
    // would drop the very landing we want and stall settling.
    for (const t of [(-a1 - sq) / (2 * a2), (-a1 + sq) / (2 * a2)]) {
      if (t <= lo + TIME_EPS || t > s.hi + TIME_EPS) continue;
      if (2 * a2 * t + a1 > 0) continue; // ascending crossing (leaving the bed) — skip
      const clamped = Math.min(t, s.hi);
      if (clamped < best) best = clamped;
    }
  }
  return best < Infinity ? { time: best } : null;
}
