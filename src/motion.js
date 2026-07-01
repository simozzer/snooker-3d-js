// motion.js — closed-form ball trajectory. TRUE 3D: each ball is always in exactly one of
// three phases, all degree ≤ 2 per axis, so the engine's quadratic/quartic event solvers apply
// unchanged (dimension-agnostic — going 2D→3D does NOT raise polynomial degree).
//
//   SLIDE  [0, tRoll]:  the contact patch slips. Kinetic friction opposes the slip velocity u,
//     which keeps a CONSTANT direction and shrinks linearly, so the centre acceleration is a
//     CONSTANT vector and the centre follows a PARABOLA p0 + v0 t + ½ aSlide t² in the table
//     plane. z is pinned to R, vz = 0. Follow/draw/swerve curve lives here.
//   ROLL   [tRoll, tStop]:  slip gone; the ball rolls without slipping under small rolling
//     resistance anti-parallel to v — a STRAIGHT line. z = R.
//   FLIGHT [0, ∞):  airborne projectile p = P + V t + ½ g t², gravity g = (0,0,−9.81). Spin ω is
//     FROZEN (no torque on a sphere in vacuum; air/Magnus ignored at this scale). Ended by a bed
//     (z = R) event that the engine resolves as a floor bounce back into SLIDE.
//
// Transitions: SLIDE→ROLL at the roll threshold (internal to the plan). on-table→FLIGHT is
// ENTERED BY a collision that imparts upward velocity (not a scheduled self-event) — replan sees
// vz > 0 and builds a flight plan. FLIGHT→bed is a floor event (events.detectBed) the engine
// bounces. Multi-bounce settles through the event loop; no special-casing.
//
// Spin is a 3-vector {x,y,z}: (x,y) is the horizontal-axis angular velocity (drives roll /
// follow / draw / swerve via the slip), z is the vertical axis (side / "English").

import * as v from './vec3.js';
import { GRAVITY, MU_SLIDE, MU_ROLL, SLIP_FACTOR, SIDE_DECEL } from './snooker.js';

const REST = 1e-9;
const A_SLIDE = MU_SLIDE * GRAVITY; // centre deceleration magnitude while sliding
const A_ROLL = MU_ROLL * GRAVITY; // rolling-resistance deceleration
export const G = { x: 0, y: 0, z: -GRAVITY }; // free-fall acceleration in flight

export const PHASE = { SLIDE: 'slide', ROLL: 'roll', FLIGHT: 'flight' };

// 90° CCW perpendicular of the horizontal (x,y) part — the 2D slip/spin coupling is unchanged.
const perpH = (a) => ({ x: -a.y, y: a.x });

// Slip velocity of the bottom contact point: u = v_h + R·perp(s_h), s_h = (spin.x, spin.y).
// (u = v + ω × (−R ẑ); the z spin contributes nothing at the bottom point, in-plane only.)
export function slip(vel, spin, R) {
  const w = perpH({ x: spin.x, y: spin.y });
  return { x: vel.x + R * w.x, y: vel.y + R * w.y };
}

// Inverse of perpH: given w = perpH(s_h), recover s_h. (perpH(perpH(a)) = −a.)
const invPerp = (w) => ({ x: w.y, y: -w.x });

// Airborne plan: single flight phase p = P + V t + ½ g t², spin frozen. tStop is a coasting
// fallback (flight duration to z=R) only — in practice a bed event ends it far sooner.
function flightPlan(pos, vel, spin, R) {
  const P = { x: pos.x, y: pos.y, z: pos.z };
  const V = { x: vel.x, y: vel.y, z: vel.z };
  // Larger root of R = Pz + Vz t − ½g t²  (z falling back to the bed), else 0.
  const a = 0.5 * GRAVITY;
  const b = -V.z;
  const c = R - P.z;
  const disc = b * b - 4 * a * c;
  const tStop = disc < 0 ? 0 : Math.max(0, (-b + Math.sqrt(disc)) / (2 * a));
  return { phase: PHASE.FLIGHT, P, V, spin0: { ...spin }, R, tStop, tRoll: 0 };
}

// Build the closed-form plan from a starting state. Pure. If launched airborne (z above the bed
// or with upward vz) it's a FLIGHT plan; otherwise the two-phase (slide→roll) on-table plan.
export function twoPhasePlan(pos, vel, spin, R) {
  const z = pos.z ?? R;
  const vz = vel.z ?? 0;
  if (z > R + 1e-9 || vz > 1e-9) {
    return flightPlan({ x: pos.x, y: pos.y, z }, { x: vel.x, y: vel.y, z: vz }, spin, R);
  }

  const p0 = { x: pos.x, y: pos.y };
  const v0 = { x: vel.x, y: vel.y };
  const u0 = slip(v0, spin, R);
  const su = Math.hypot(u0.x, u0.y);

  const base = { phase: PHASE.SLIDE, spin0: { ...spin }, R };

  // Already rolling (slip ~ 0): single straight roll phase (or fully at rest).
  if (su <= REST) {
    const sp = Math.hypot(v0.x, v0.y);
    if (sp <= REST) {
      return { ...base, p0, v0, aSlide: { x: 0, y: 0 }, tRoll: 0, pRoll: p0, vRoll: { x: 0, y: 0 }, tStop: 0 };
    }
    const tStop = sp / A_ROLL;
    return { ...base, p0, v0, aSlide: { x: 0, y: 0 }, tRoll: 0, pRoll: p0, vRoll: v0, tStop };
  }

  // Slide phase: constant centre acceleration opposite the slip; slip dies at tRoll.
  const uhat = { x: u0.x / su, y: u0.y / su };
  const aSlide = { x: -A_SLIDE * uhat.x, y: -A_SLIDE * uhat.y };
  const tRoll = su / (SLIP_FACTOR * A_SLIDE);
  const pRoll = {
    x: p0.x + v0.x * tRoll + 0.5 * aSlide.x * tRoll * tRoll,
    y: p0.y + v0.y * tRoll + 0.5 * aSlide.y * tRoll * tRoll,
  };
  const vRoll = { x: v0.x + aSlide.x * tRoll, y: v0.y + aSlide.y * tRoll };
  const sRoll = Math.hypot(vRoll.x, vRoll.y);
  const tStop = sRoll <= REST ? tRoll : tRoll + sRoll / A_ROLL;
  return { ...base, p0, v0, aSlide, tRoll, pRoll, vRoll, tStop };
}

// Position at absolute time t along the plan. Always returns {x,y,z}.
export function posAt(plan, t) {
  if (plan.phase === PHASE.FLIGHT) {
    const tt = Math.max(0, t);
    return {
      x: plan.P.x + plan.V.x * tt,
      y: plan.P.y + plan.V.y * tt,
      z: plan.P.z + plan.V.z * tt + 0.5 * G.z * tt * tt,
    };
  }
  const tt = Math.max(0, Math.min(t, plan.tStop));
  if (tt <= plan.tRoll) {
    return {
      x: plan.p0.x + plan.v0.x * tt + 0.5 * plan.aSlide.x * tt * tt,
      y: plan.p0.y + plan.v0.y * tt + 0.5 * plan.aSlide.y * tt * tt,
      z: plan.R,
    };
  }
  const tau = tt - plan.tRoll;
  const sp = Math.hypot(plan.vRoll.x, plan.vRoll.y);
  if (sp <= REST) return { x: plan.pRoll.x, y: plan.pRoll.y, z: plan.R };
  const dir = { x: plan.vRoll.x / sp, y: plan.vRoll.y / sp };
  const s = sp * tau - 0.5 * A_ROLL * tau * tau;
  return { x: plan.pRoll.x + dir.x * s, y: plan.pRoll.y + dir.y * s, z: plan.R };
}

// Velocity at absolute time t. Always returns {x,y,z}.
export function velAt(plan, t) {
  if (plan.phase === PHASE.FLIGHT) {
    const tt = Math.max(0, t);
    return { x: plan.V.x, y: plan.V.y, z: plan.V.z + G.z * tt };
  }
  if (t >= plan.tStop) return { x: 0, y: 0, z: 0 };
  if (t <= plan.tRoll) {
    const tt = Math.max(0, t);
    return { x: plan.v0.x + plan.aSlide.x * tt, y: plan.v0.y + plan.aSlide.y * tt, z: 0 };
  }
  const tau = t - plan.tRoll;
  const sp = Math.hypot(plan.vRoll.x, plan.vRoll.y);
  if (sp <= REST) return { x: 0, y: 0, z: 0 };
  const left = sp - A_ROLL * tau;
  return left <= 0 ? { x: 0, y: 0, z: 0 } : { x: plan.vRoll.x * (left / sp), y: plan.vRoll.y * (left / sp), z: 0 };
}

// Spin 3-vector at absolute time t. In flight, spin is FROZEN. On the table the horizontal part
// is recovered from the current slip state; the vertical (side) part decays linearly toward zero.
export function spinAt(plan, t) {
  if (plan.phase === PHASE.FLIGHT) return { ...plan.spin0 };
  const tt = Math.max(0, Math.min(t, plan.tStop));
  const vel = velAt(plan, tt);
  let u;
  if (tt < plan.tRoll) {
    const u0 = slip(plan.v0, plan.spin0, plan.R);
    const su0 = Math.hypot(u0.x, u0.y);
    const left = su0 - SLIP_FACTOR * A_SLIDE * tt;
    u = left <= 0 ? { x: 0, y: 0 } : { x: u0.x * (left / su0), y: u0.y * (left / su0) };
  } else {
    u = { x: 0, y: 0 };
  }
  const sh = invPerp({ x: (u.x - vel.x) / plan.R, y: (u.y - vel.y) / plan.R }); // perp(s) = (u − v)/R
  const z0 = plan.spin0.z || 0;
  const dz = SIDE_DECEL * tt;
  const z = Math.abs(z0) <= dz ? 0 : z0 - Math.sign(z0) * dz;
  return { x: sh.x, y: sh.y, z };
}

// Express the plan as polynomial segments in ABSOLUTE time, given t0 (the absolute time at which
// the plan was built). Each segment is { lo, hi, P, V, C } with
//   position(t) = P + V·t + C·t²   for t in (lo, hi]  (per axis; C is HALF the acceleration).
// P/V/C are 3-vectors: on-table segments pin Pz=R, Vz=Cz=0; the flight segment carries Cz=½g.
export function segments(plan, t0 = 0) {
  const out = [];
  // local-time coeffs → absolute via τ = t − t0.  P + V τ + C τ²  =  Pabs + Vabs t + Cabs t².
  const push = (loL, hiL, P, V, C) => {
    const Cabs = C;
    const Vabs = v.sub(V, v.scale(C, 2 * t0));
    const Pabs = v.add(v.sub(P, v.scale(V, t0)), v.scale(C, t0 * t0));
    out.push({ lo: t0 + loL, hi: t0 + hiL, P: Pabs, V: Vabs, C: Cabs });
  };

  if (plan.phase === PHASE.FLIGHT) {
    push(0, plan.tStop, plan.P, plan.V, v.scale(G, 0.5));
    return out;
  }

  if (plan.tStop <= 0) return out;
  if (plan.tRoll > 0) {
    // slide: p0 + v0 τ + ½ aSlide τ²
    push(
      0,
      plan.tRoll,
      { x: plan.p0.x, y: plan.p0.y, z: plan.R },
      { x: plan.v0.x, y: plan.v0.y, z: 0 },
      { x: 0.5 * plan.aSlide.x, y: 0.5 * plan.aSlide.y, z: 0 },
    );
  }
  if (plan.tStop > plan.tRoll) {
    const sp = Math.hypot(plan.vRoll.x, plan.vRoll.y);
    if (sp > 1e-12) {
      const dir = { x: plan.vRoll.x / sp, y: plan.vRoll.y / sp };
      const C = { x: -0.5 * A_ROLL * dir.x, y: -0.5 * A_ROLL * dir.y, z: 0 };
      const V = { x: dir.x * (sp + A_ROLL * plan.tRoll), y: dir.y * (sp + A_ROLL * plan.tRoll), z: 0 };
      const tR = plan.tRoll;
      const P = {
        x: plan.pRoll.x - V.x * tR - C.x * tR * tR,
        y: plan.pRoll.y - V.y * tR - C.y * tR * tR,
        z: plan.R,
      };
      push(plan.tRoll, plan.tStop, P, V, C);
    }
  }
  return out;
}

// Segments clamped to start at tNow and extended with a trailing constant "rest" segment out to
// `horizon`, so a moving ball vs a resting one falls out of the same per-segment pair search.
export function segmentsToHorizon(ball, tNow, horizon) {
  const segs = segments(ball.plan, ball.t0).filter((s) => s.hi > tNow);
  if (!segs.length) {
    const p = { x: ball.pos.x, y: ball.pos.y, z: ball.pos.z ?? ball.radius };
    return horizon > tNow ? [{ lo: tNow, hi: horizon, P: p, V: v.vec(0, 0, 0), C: v.vec(0, 0, 0) }] : [];
  }
  const lastHi = segs[segs.length - 1].hi;
  if (horizon > lastHi) {
    const restPos = posAt(ball.plan, ball.plan.tStop);
    segs.push({ lo: lastHi, hi: horizon, P: restPos, V: v.vec(0, 0, 0), C: v.vec(0, 0, 0) });
  }
  return segs;
}

// A snooker ball: 3D position, 3D velocity, full spin vector, phase, and a cached motion plan
// rebuilt whenever velocity/spin changes (at a strike or a collision). `t0` is the absolute time
// the current plan was built (set by the engine).
export class Ball {
  constructor({ id, kind, pos, vel = v.vec(0, 0, 0), spin = { x: 0, y: 0, z: 0 }, radius, mass, color }) {
    this.id = id;
    this.kind = kind; // 'cue' | 'red' | 'colour'
    this.color = color;
    this.pos = { x: pos.x, y: pos.y, z: pos.z ?? radius };
    this.vel = { x: vel.x, y: vel.y, z: vel.z ?? 0 };
    this.spin = { x: spin.x || 0, y: spin.y || 0, z: spin.z || 0 };
    this.radius = radius;
    this.mass = mass;
    this.pocketed = false;
    this.t0 = 0;
    this.replan();
  }

  replan() {
    this.plan = twoPhasePlan(this.pos, this.vel, this.spin, this.radius);
  }

  get phase() {
    return this.plan.phase;
  }
  get speed() {
    return v.len(this.vel);
  }
  // Still has motion ahead if its plan reaches rest in the future — true even when the CENTRE is
  // momentarily still but residual spin will drive it, and always true in FLIGHT (a bed event
  // ends flight, not tStop).
  get moving() {
    return this.plan.phase === PHASE.FLIGHT || this.plan.tStop > REST;
  }
  stopTime() {
    return this.plan.tStop;
  }
  rollTime() {
    return this.plan.tRoll;
  }
  posAt(t) {
    return posAt(this.plan, t);
  }
  velAt(t) {
    return velAt(this.plan, t);
  }
  spinAt(t) {
    return spinAt(this.plan, t);
  }
}
