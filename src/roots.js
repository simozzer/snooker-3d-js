// roots.js — root finding for collision-time solves.
//
// The live engine's trajectories are piecewise P + V·t + C·t² (motion.segments), so every contact
// time is an EXACT polynomial solve — the engine never samples a path:
//   cubicRoots       — real roots of a cubic (Cardano); used by events.js to bracket the contact
//                      quartic at its critical points (so every sub-interval is monotonic).
//   firstQuarticRoot — first downward crossing of the contact quartic |Δp(t)|²−R², bracketed via
//                      cubicRoots. Catches a graze finer than any fixed step; powers pocket
//                      detection, and the same bracketing drives pair/wall detection in events.js.
//
// Two helpers here are NOT on the live path, kept as documented utilities:
//   smallestPositiveQuadratic — exact smaller-positive root; superseded for cushions by events.js
//                               firstApproachQuad (which skips a wall the ball is LEAVING).
//   firstRoot                 — generic sampled fallback for a future NON-polynomial trajectory
//                               model (ball hop, cushion-nose height). See README scope notes.

const EPS = 1e-12;

// Smallest root > minT of  a t^2 + b t + c = 0, or Infinity if none.
export function smallestPositiveQuadratic(a, b, c, minT = EPS) {
  if (Math.abs(a) < EPS) {
    if (Math.abs(b) < EPS) return Infinity;
    const t = -c / b;
    return t > minT ? t : Infinity;
  }
  const disc = b * b - 4 * a * c;
  if (disc < 0) return Infinity;
  const s = Math.sqrt(disc);
  const t1 = (-b - s) / (2 * a);
  const t2 = (-b + s) / (2 * a);
  let best = Infinity;
  if (t1 > minT) best = t1;
  if (t2 > minT && t2 < best) best = t2;
  return best;
}

// Real roots of a t^2 + b t + c (any order, may return 0/1/2 roots).
function quadReal(a, b, c) {
  if (Math.abs(a) < EPS) {
    if (Math.abs(b) < EPS) return [];
    return [-c / b];
  }
  const disc = b * b - 4 * a * c;
  if (disc < 0) return [];
  const s = Math.sqrt(disc);
  return [(-b - s) / (2 * a), (-b + s) / (2 * a)];
}

// Real roots of a cubic a t^3 + b t^2 + c t + d (Cardano, trig form for 3 real roots).
export function cubicRoots(a, b, c, d) {
  if (Math.abs(a) < EPS) return quadReal(b, c, d);
  const p = b / a;
  const q = c / a;
  const r = d / a;
  // depress: t = x - p/3  ->  x^3 + P x + Q
  const P = q - (p * p) / 3;
  const Q = (2 * p * p * p) / 27 - (p * q) / 3 + r;
  const shift = -p / 3;
  const disc = (Q * Q) / 4 + (P * P * P) / 27;
  if (disc > EPS) {
    const s = Math.sqrt(disc);
    return [Math.cbrt(-Q / 2 + s) + Math.cbrt(-Q / 2 - s) + shift];
  }
  if (disc < -EPS) {
    // three distinct real roots
    const m = 2 * Math.sqrt(-P / 3);
    let arg = (3 * Q) / (P * m);
    arg = Math.max(-1, Math.min(1, arg)); // clamp for acos safety
    const th = Math.acos(arg) / 3;
    return [0, 1, 2].map((k) => m * Math.cos(th - (2 * Math.PI * k) / 3) + shift);
  }
  // disc ~ 0: repeated roots
  const u = Math.cbrt(-Q / 2);
  return [2 * u + shift, -u + shift];
}

// First t in (lo, hi] where the quartic q(t)=k4 t^4+..+k0 crosses to <= 0, assuming
// q(lo) > 0. Exact: brackets via the quartic's critical points (cubic q'=0), then
// bisects the first monotonic segment that changes sign. Infinity if it never crosses.
export function firstQuarticRoot(k4, k3, k2, k1, k0, lo, hi, tol = 1e-10) {
  const q = (t) => (((k4 * t + k3) * t + k2) * t + k1) * t + k0;
  if (hi <= lo) return Infinity;
  if (q(lo) <= 0) return lo;
  // critical points: q'(t) = 4k4 t^3 + 3k3 t^2 + 2k2 t + k1
  const crit = cubicRoots(4 * k4, 3 * k3, 2 * k2, k1)
    .filter((t) => t > lo && t < hi)
    .sort((x, y) => x - y);
  let a = lo;
  for (const bp of [...crit, hi]) {
    if (q(bp) <= 0) {
      let x0 = a;
      let x1 = bp;
      while (x1 - x0 > tol) {
        const m = 0.5 * (x0 + x1);
        if (q(m) <= 0) x1 = m;
        else x0 = m;
      }
      return 0.5 * (x0 + x1);
    }
    a = bp;
  }
  return Infinity;
}

// First t in (0, horizon] where f crosses to <= 0, refined by bisection. The generic SAMPLED
// fallback (see header) for a NON-polynomial gap function f(t) (e.g. ball-vs-torus jaw distance)
// that has no closed-form roots. Two things make it graze-safe — the whole reason it exists:
//   1. Boundary sign changes: an endpoint f(tPrev)>0, f(t)<=0 brackets a crossing (the easy case).
//   2. Interior GRAZES: if f dips <=0 and back up WITHIN one step (both endpoints >0), a plain
//      boundary scan skips it. So within each positive-endpoint step we also seed at the interior
//      LOCAL MINIMUM: sub-sample the step, find the lowest point; if it is <=0 the graze is real,
//      and we bisect the rising-into-it half [tPrev, tmin] for the FIRST crossing. Seeding the
//      sampler with critical points (the step's local min) is exactly what its comment anticipated.
// `steps` sets the coarse scan; `sub` the interior critical-point search per step.
export function firstRoot(f, horizon, steps = 256, tol = 1e-9, sub = 8) {
  const bisect = (lo, hi) => { // first crossing in [lo,hi] given f(lo)>0, f(hi)<=0
    while (hi - lo > tol) { const m = 0.5 * (lo + hi); if (f(m) <= 0) hi = m; else lo = m; }
    return 0.5 * (lo + hi);
  };
  if (f(0) <= 0) return 0; // already in contact
  const dt = horizon / steps;
  let tPrev = 0;
  let fPrev = f(0);
  for (let i = 1; i <= steps; i++) {
    const t = i * dt;
    const ft = f(t);
    if (ft <= 0) return bisect(tPrev, t); // boundary crossing
    // both endpoints > 0: hunt an interior graze via the step's local minimum
    let tMin = tPrev;
    let fMin = fPrev;
    for (let k = 1; k < sub; k++) {
      const tk = tPrev + (dt * k) / sub;
      const fk = f(tk);
      if (fk < fMin) { fMin = fk; tMin = tk; }
    }
    if (fMin <= 0) return bisect(tPrev, tMin); // a real graze in this step
    tPrev = t;
    fPrev = ft;
  }
  return Infinity;
}
