// collisions.js — impulse resolution for snooker balls (uniform SPHERES).
//
// Normal: linear impulse along the contact normal with restitution e (conserves momentum;
//   elastic at e=1). Same core as carrom, but the masses/inertia are a sphere's.
// Tangential ("cut-induced throw" at ball–ball, "grip" at a cushion): friction impulse along
//   the contact tangent, Coulomb-clamped to muT·|jn|, exchanging side-spin (ω_z) and sideways
//   velocity. Only the VERTICAL-axis spin ω_z contributes to the in-plane tangential surface
//   velocity at the contact (the horizontal-axis spin's contribution is out-of-plane), so the
//   2D throw math is identical to carrom's — only the inertia factor differs.
// Follow/draw: the HORIZONTAL-axis spin (ω_x, ω_y) is deliberately left untouched by the
//   impact. The cue ball keeps its top/back spin through the collision, so when the engine
//   rebuilds its plan from the new (small/zero) velocity + retained spin, the next slide phase
//   produces follow-through / screw-back automatically. This is the whole point of two phases.

import * as v from './vec2.js';
import * as v3 from './vec3.js';
import { INERTIA_FACTOR } from './snooker.js';

// Sphere: I = INERTIA_FACTOR · m r²  (= 2/5 m r²). So r²/I = 1/(INERTIA_FACTOR·m).
const inertiaOf = (b) => INERTIA_FACTOR * b.mass * b.radius * b.radius;

// Resolve a ball/ball collision in place. Mutates a.vel/b.vel and (if muT>0) a.spin.z/b.spin.z.
// Returns the normal closing speed (≥0) — the impact "hardness" for sound.
export function resolvePair(a, b, restitution, muT = 0) {
  const n = v.normalize(v.sub(a.pos, b.pos)); // contact normal, b → a
  const vrel = v.sub(a.vel, b.vel);
  const vn = v.dot(vrel, n);
  if (vn > 0) return 0; // separating already
  const closing = -vn;

  const invA = 1 / a.mass;
  const invB = 1 / b.mass;
  const jn = (-(1 + restitution) * vn) / (invA + invB);
  a.vel = v.add(a.vel, v.scale(n, jn * invA));
  b.vel = v.sub(b.vel, v.scale(n, jn * invB));

  if (muT <= 0) return closing;

  const t = v.perp(n);
  const Ia = inertiaOf(a);
  const Ib = inertiaOf(b);
  // tangential relative SURFACE velocity (linear slip + side-spin slip)
  const ut = v.dot(vrel, t) - (a.spin.z * a.radius + b.spin.z * b.radius);
  const invMt = invA + invB + (a.radius * a.radius) / Ia + (b.radius * b.radius) / Ib;
  let jt = -ut / invMt;
  const cap = muT * Math.abs(jn);
  if (jt > cap) jt = cap;
  else if (jt < -cap) jt = -cap;

  a.vel = v.add(a.vel, v.scale(t, jt * invA));
  b.vel = v.sub(b.vel, v.scale(t, jt * invB));
  a.spin.z += (-a.radius * jt) / Ia;
  b.spin.z += (-b.radius * jt) / Ib;
  return closing;
}

// Reflect the normal velocity component off an axis-aligned cushion, scaled by restitution.
// restThreshold zeroes a tiny rebound (anti-Zeno). muT>0 adds cushion grip: ω_z ↔ tangential
// velocity. Returns the incoming normal speed (≥0). Horizontal-axis spin is left untouched —
// the engine's replan turns the post-bounce velocity + retained spin into a fresh slide.
export function resolveWall(ball, axis, restitution, restThreshold = 1e-3, muT = 0) {
  const vx = ball.vel.x;
  const vy = ball.vel.y;
  const impact = Math.abs(axis === 'x' ? vx : vy);

  let nvx = vx;
  let nvy = vy;
  if (axis === 'x') {
    nvx = -vx * restitution;
    if (Math.abs(nvx) < restThreshold) nvx = 0;
  } else {
    nvy = -vy * restitution;
    if (Math.abs(nvy) < restThreshold) nvy = 0;
  }
  // preserve any vertical velocity: this is an axis-aligned WALL, its normal is horizontal, so a
  // vz (a ball hopping when the frame backstop catches it) passes through untouched rather than
  // being silently dropped. Inert for the flat 2D game (vz is 0/undefined there).
  const vz = ball.vel.z ?? 0;
  ball.vel = { x: nvx, y: nvy, z: vz };

  if (muT <= 0) return impact;

  const I = inertiaOf(ball);
  const invM = 1 / ball.mass;
  let nIx;
  let nIy;
  let jnMag;
  if (axis === 'x') {
    nIx = -Math.sign(vx);
    nIy = 0;
    jnMag = ball.mass * Math.abs(vx) * (1 + restitution);
  } else {
    nIx = 0;
    nIy = -Math.sign(vy);
    jnMag = ball.mass * Math.abs(vy) * (1 + restitution);
  }
  const tx = -nIy; // perp(n)
  const ty = nIx;
  const vt = ball.vel.x * tx + ball.vel.y * ty;
  const ut = vt - ball.spin.z * ball.radius;
  const invMt = invM + (ball.radius * ball.radius) / I;
  let jt = -ut / invMt;
  const cap = muT * jnMag;
  if (jt > cap) jt = cap;
  else if (jt < -cap) jt = -cap;

  ball.vel = { x: ball.vel.x + jt * invM * tx, y: ball.vel.y + jt * invM * ty, z: ball.vel.z ?? 0 };
  ball.spin.z += (-ball.radius * jt) / I;
  return impact;
}

// Resolve a ball/ball collision in FULL 3D. Isotropic-sphere impulse with two finite masses
// (reduced-mass denominators) and EQUAL-AND-OPPOSITE impulses on both bodies. The contact normal
// is the centre-to-centre unit vector in 3D (so a ball landing on TOP of another has a normal with
// a z component and is launched off it).
//
// Follows the documented snooker rule (as the cushion does): HORIZONTAL-AXIS spin (follow/draw,
// ω_x/ω_y) is PRESERVED through the impact — it neither drives the tangential throw nor is changed
// by it; the engine's replan re-expresses it as the post-contact slide. Only VELOCITY and
// VERTICAL-axis (side, ω_z) spin couple tangentially ("cut-induced throw"). Coupling follow/draw
// here would be wrong physics AND numerically dangerous: for a rolling ball ω × r_contact has a
// vertical component even on a flat (n_z=0) contact, so friction would pump a spurious vertical
// impulse and, in a cluster, snowball flat balls off the bed. This reduces EXACTLY to the 2D
// `resolvePair` on the bed (verified <1e-12). Mutates a/b vel and spin. Returns the closing speed.
export function resolvePair3D(a, b, restitution, muT = 0) {
  const n = v3.normalize(v3.sub(a.pos, b.pos)); // contact normal, b → a
  const invA = 1 / a.mass;
  const invB = 1 / b.mass;
  const Ia = inertiaOf(a);
  const Ib = inertiaOf(b);

  // Normal closing along the centre line (sphere ⇒ spin carries no torque about a radial arm, so
  // the bounce magnitude is a centre-velocity quantity — no spin in vn):
  const vn = v3.dot(v3.sub(a.vel, b.vel), n);
  if (vn > 0) return 0; // separating already
  const closing = -vn;

  const jnMag = (-(1 + restitution) * vn) / (invA + invB);
  const Jn = v3.scale(n, jnMag);
  a.vel = v3.add(a.vel, v3.scale(Jn, invA));
  b.vel = v3.sub(b.vel, v3.scale(Jn, invB));

  if (muT <= 0) return closing;

  // Tangential slip from VELOCITY + SIDE spin only (ω_side = (0,0,ω_z)); follow/draw excluded.
  const ra = v3.scale(n, -a.radius);
  const rb = v3.scale(n, b.radius);
  const surfA = v3.add(a.vel, v3.cross(v3.vec(0, 0, a.spin.z), ra));
  const surfB = v3.add(b.vel, v3.cross(v3.vec(0, 0, b.spin.z), rb));
  const u = v3.sub(surfA, surfB);
  const ut = v3.sub(u, v3.scale(n, v3.dot(u, n))); // tangential component
  const utMag = v3.len(ut);
  if (utMag > 1e-12) {
    const tHat = v3.scale(ut, 1 / utMag);
    const invMt = invA + invB + (a.radius * a.radius) / Ia + (b.radius * b.radius) / Ib;
    const jtMag = Math.min(muT * Math.abs(jnMag), utMag / invMt);
    const Jt = v3.scale(tHat, -jtMag); // opposes the slip
    a.vel = v3.add(a.vel, v3.scale(Jt, invA));
    b.vel = v3.sub(b.vel, v3.scale(Jt, invB));
    // update ONLY ω_z (side); leave ω_x/ω_y (follow/draw) untouched
    a.spin.z += v3.cross(ra, Jt).z / Ia;
    b.spin.z -= v3.cross(rb, Jt).z / Ib;
  }
  return closing;
}

// Generic 3D contact impulse against a fixed surface with outward normal `n` (unit). Isotropic
// sphere ⇒ scalar inertia I = ⅖ m R² (no inertia tensor, no precession). Contact point is at the
// ball surface along −n, so r_contact = −R·n. Mutates ball.vel (3-vec) and ball.spin (3-vec).
//
//   • relative surface velocity at the contact = v + ω × r_contact
//   • normal impulse:  jn = −(1+e)·v_n·m   (v_n ≤ 0 approaching), reflects the normal component
//   • tangential impulse: Coulomb-clamped to min(μ·|jn|, impulse to kill the tangential slip),
//     applied opposite the slip; angular update Δω = (r_contact × J)/I with scalar I.
//
// The bed (floor) bounce passes n = (0,0,1): the SAME code converts landing spin ↔ velocity, so a
// backspun ball checks / draws back on landing with no bespoke path.
// Returns the incoming normal closing speed (≥0) — the bounce "hardness".
export function resolveContact(ball, n, restitution, muT = 0) {
  const R = ball.radius;
  const m = ball.mass;
  const I = inertiaOf(ball);
  const r = v3.scale(n, -R); // contact point relative to centre
  const w = ball.spin;

  // surface velocity at the contact point (linear + rotational)
  const vc = v3.add(ball.vel, v3.cross(w, r));
  const vn = v3.dot(vc, n);
  if (vn >= 0) return 0; // separating already
  const closing = -vn;

  // normal impulse along n (fixed, infinite-mass surface): jn = −(1+e)·vn·m
  const jnMag = -(1 + restitution) * vn * m;
  let J = v3.scale(n, jnMag);
  ball.vel = v3.add(ball.vel, v3.scale(J, 1 / m));
  ball.spin = v3.add(ball.spin, v3.scale(v3.cross(r, J), 1 / I));

  if (muT > 0) {
    // recompute tangential slip AFTER the normal impulse
    const vc2 = v3.add(ball.vel, v3.cross(ball.spin, r));
    const vt = v3.sub(vc2, v3.scale(n, v3.dot(vc2, n))); // tangential component
    const vtMag = v3.len(vt);
    if (vtMag > 1e-12) {
      const tHat = v3.scale(vt, 1 / vtMag);
      // impulse (opposing slip) that would exactly kill the tangential surface velocity:
      //   Δv_t at contact per unit impulse = 1/m + R²/I along tHat ⇒ jt_full = vtMag / (1/m + R²/I)
      const invMt = 1 / m + (R * R) / I;
      const jtFull = vtMag / invMt;
      const jtMag = Math.min(muT * jnMag, jtFull);
      const Jt = v3.scale(tHat, -jtMag);
      ball.vel = v3.add(ball.vel, v3.scale(Jt, 1 / m));
      ball.spin = v3.add(ball.spin, v3.scale(v3.cross(r, Jt), 1 / I));
    }
  }
  return closing;
}

// Bounce a ball off a straight-rail CUSHION CYLINDER. The contact normal is the unit vector from
// the cylinder axis to the ball centre in the plane perpendicular to the axis; because the axis
// sits slightly BELOW ball-centre height it tilts a little upward, so the normal reflection of the
// ball's velocity gains a small vertical component — a firm shot HOPS, emergent from the geometry.
//
// Unlike the generic resolveContact, the cushion follows the documented snooker rule: HORIZONTAL-
// AXIS spin (follow/draw, ω_x/ω_y) passes through UNTOUCHED — the engine's replan re-expresses it
// as the next slide. Only the ball's velocity and VERTICAL-axis (side, ω_z) spin interact with the
// cushion (the same coupling the flat-wall model had), now on the tilted 3D normal. Coupling the
// heavy follow/draw spin here instead would pump a huge spurious vertical impulse (a topspin ball
// would launch metres up). Returns the normal closing speed (≥0).
export function resolveRail(ball, rail, restitution, muT = 0) {
  const R = ball.radius;
  const m = ball.mass;
  const I = inertiaOf(ball);
  // Contact normal at the DESIGN contact point (ball centre at bed height): the inward-perp offset
  // is R and the ball sits `drop` above the axis, so n ∝ (R, drop) in the (perp, z) plane, tilted
  // slightly upward. Using the nominal geometry (not the ball's instantaneous z) keeps the hop
  // bounded — a ball contacting the rail while already a little airborne can't ride higher up the
  // cylinder and get launched (that feedback let firm/spun shots jump clean over the far cushion).
  const drop = R - rail.z;
  const perpDir = ball.pos[rail.axis === 'x' ? 'y' : 'x'] - rail.perp >= 0 ? 1 : -1;
  const n = rail.axis === 'x'
    ? v3.normalize(v3.vec(0, perpDir * R, drop))
    : v3.normalize(v3.vec(perpDir * R, 0, drop));

  const vn = v3.dot(ball.vel, n);
  if (vn >= 0) return 0; // separating already
  const closing = -vn;

  // Normal impulse reflects the centre velocity's normal component (the tilt gives the hop):
  const jnMag = -(1 + restitution) * vn * m;
  ball.vel = v3.add(ball.vel, v3.scale(n, jnMag / m));

  if (muT > 0) {
    // Tangential slip from velocity + SIDE spin only (ω_side = (0,0,ω_z)); follow/draw excluded.
    const r = v3.scale(n, -R);
    const wSide = v3.vec(0, 0, ball.spin.z);
    const surf = v3.add(ball.vel, v3.cross(wSide, r));
    const vt = v3.sub(surf, v3.scale(n, v3.dot(surf, n)));
    const vtMag = v3.len(vt);
    if (vtMag > 1e-12) {
      const tHat = v3.scale(vt, 1 / vtMag);
      const invMt = 1 / m + (R * R) / I;
      const jtMag = Math.min(muT * jnMag, vtMag / invMt);
      const Jt = v3.scale(tHat, -jtMag);
      ball.vel = v3.add(ball.vel, v3.scale(Jt, 1 / m));
      // update ONLY ω_z (side); leave ω_x/ω_y (follow/draw) untouched
      ball.spin.z += (v3.cross(r, Jt).z) / I;
    }
  }
  return closing;
}

// Bounce a ball off a pocket-JAW torus (Milestone C2). The contact normal points from the nearest
// point on the torus centre-circle to the ball centre: project the centre into the ring's plane,
// take the radial direction to the ring, the nearest ring point is centre + Rring·radialHat, and n
// is the unit vector from there to the ball. A jaw is a rounded post, so it uses the generic 3D
// resolveContact (all spin couples, like a ball-ball knuckle) — the rattle emerges from the normal
// geometry: a glancing hit near the mouth deflects the ball back into play or lets it drop. Returns
// the normal closing speed (≥0).
export function resolveJaw(ball, jaw, restitution, muT = 0) {
  const dx = ball.pos.x - jaw.cx;
  const dy = ball.pos.y - jaw.cy;
  const rho = Math.hypot(dx, dy);
  // radial (in-plane) unit direction from the ring axis toward the ball; degenerate on the axis.
  const radial = rho > 1e-12 ? { x: dx / rho, y: dy / rho } : { x: 1, y: 0 };
  const ring = { x: jaw.cx + jaw.Rring * radial.x, y: jaw.cy + jaw.Rring * radial.y, z: jaw.z };
  const n = v3.normalize(v3.sub(ball.pos, ring));
  return resolveContact(ball, n, restitution, muT);
}

// A ball reaching a pocket throat too fast and off-line to drop RATTLES back into play. Reflect the
// OUTWARD horizontal velocity component (along the opening direction = outward radial from table centre
// toward the pocket) with restitution. Reversing any edge-ward motion guarantees the ball can never pass
// through the mouth gap — so gating capture by speed/line can't reintroduce tunnelling. Returns the
// outward closing speed (0 if it wasn't heading out) for the collision-sound intensity.
export function resolvePocketRebound(ball, center, restitution) {
  const nl = Math.hypot(center.x, center.y) || 1;
  const nx = center.x / nl;
  const ny = center.y / nl;
  const vn = ball.vel.x * nx + ball.vel.y * ny;
  if (vn <= 0) return 0; // already moving inward — nothing to reflect
  ball.vel.x -= (1 + restitution) * vn * nx;
  ball.vel.y -= (1 + restitution) * vn * ny;
  return vn;
}
