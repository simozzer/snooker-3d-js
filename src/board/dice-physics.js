// dice-physics.js — a headless, deterministic 3D rigid-body simulator for tumbling dice, built to
// the staged plan: spheres for the broad phase and for die–die response, full oriented-box (OBB)
// contacts against the floor and tray walls so the cubes actually bounce, spin and tumble before
// settling. It has no DOM/three.js dependency (like the cue-sports engine) so it unit-tests in Node;
// the view (web/games/dice-view.js) renders the trajectory this returns.
//
// Pipeline per throw:
//   1. seed N dice above the tray with random position / velocity / spin (seeded RNG → replayable)
//   2. substep: gravity → collision impulses (OBB-vs-plane with friction torque; die–die as spheres)
//      → integrate position + orientation → positional correction → light damping
//   3. detect settle (all dice below sleep thresholds for a spell, or a hard time cap)
//   4. snap each die to the nearest axis-aligned rest pose and read the up-face value
// simulate() returns the sampled per-frame poses plus the final face values, ready to (a) animate and
// (b) feed straight into the Farkle engine's roll(values).
//
// Frames of reference: Y is up, gravity is -Y, the floor is the plane y = 0. A unit die has side
// `size`; mass is 1 and — because a uniform cube's inertia tensor is isotropic (I·Identity) — the
// inverse inertia is the scalar `invI`, which stays valid in world space under any rotation. That one
// fact removes all the inertia-tensor rotation bookkeeping a general rigid body would need.

import { mulberry32 } from '../share.js';

// ---- small vec3 / quaternion helpers (kept local so this module stays self-contained) ----------
const V = (x = 0, y = 0, z = 0) => ({ x, y, z });
const vadd = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const vsub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const vscale = (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const vdot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const vcross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const vlen = (a) => Math.hypot(a.x, a.y, a.z);
const vnorm = (a) => { const l = vlen(a); return l < 1e-9 ? V() : vscale(a, 1 / l); };

// Quaternion {x,y,z,w}, w scalar. Hamilton product a*b.
const qmul = (a, b) => ({
  w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
  y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
  z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
});
const qnorm = (q) => { const l = Math.hypot(q.x, q.y, q.z, q.w) || 1; return { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l }; };
// Rotate vector v by quaternion q (v' = q v q*).
function qrot(q, v) {
  const { x, y, z, w } = q;
  // t = 2 * cross(q.xyz, v); v' = v + w*t + cross(q.xyz, t)
  const tx = 2 * (y * v.z - z * v.y);
  const ty = 2 * (z * v.x - x * v.z);
  const tz = 2 * (x * v.y - y * v.x);
  return {
    x: v.x + w * tx + (y * tz - z * ty),
    y: v.y + w * ty + (z * tx - x * tz),
    z: v.z + w * tz + (x * ty - y * tx),
  };
}
const qFromAxisAngle = (axis, ang) => {
  const a = vnorm(axis), s = Math.sin(ang / 2);
  return { x: a.x * s, y: a.y * s, z: a.z * s, w: Math.cos(ang / 2) };
};

// The 8 body-frame corner signs of a cube.
const CORNERS = [];
for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) CORNERS.push({ x: sx, y: sy, z: sz });

// Local face normals → pip value. Opposite faces sum to 7 (a real die). The view paints its pip
// textures to this exact mapping so the face you see up is the value the sim reads.
export const FACES = [
  { n: V(0, 1, 0), value: 1 },
  { n: V(0, -1, 0), value: 6 },
  { n: V(1, 0, 0), value: 3 },
  { n: V(-1, 0, 0), value: 4 },
  { n: V(0, 0, 1), value: 2 },
  { n: V(0, 0, -1), value: 5 },
];

// Which value points up for a die at orientation q: the face whose world normal is most +Y.
export function readUpValue(q) {
  let best = -Infinity, val = 1;
  for (const f of FACES) {
    const wy = qrot(q, f.n).y;
    if (wy > best) { best = wy; val = f.value; }
  }
  return val;
}

// Snap an orientation to the nearest of a cube's 24 axis-aligned rest poses (clean, flat resting).
// Round each rotated basis vector to its dominant signed axis, then rebuild an orthonormal, right-
// handed frame and convert back to a quaternion.
function snapQuat(q) {
  const cols = [qrot(q, V(1, 0, 0)), qrot(q, V(0, 1, 0)), qrot(q, V(0, 0, 1))];
  const axis = (v) => {
    const ax = Math.abs(v.x), ay = Math.abs(v.y), az = Math.abs(v.z);
    if (ax >= ay && ax >= az) return V(Math.sign(v.x), 0, 0);
    if (ay >= az) return V(0, Math.sign(v.y), 0);
    return V(0, 0, Math.sign(v.z));
  };
  let cx = axis(cols[0]);
  let cy = axis(cols[1]);
  // Guarantee cy is distinct from cx; if they collapsed to the same axis, recover from the cross.
  if (Math.abs(cx.x) === Math.abs(cy.x) && Math.abs(cx.y) === Math.abs(cy.y) && Math.abs(cx.z) === Math.abs(cy.z)) {
    cy = axis(cols[2]);
  }
  let cz = vcross(cx, cy); // right-handed third axis
  // matrix columns cx,cy,cz → quaternion
  const m = [[cx.x, cy.x, cz.x], [cx.y, cy.y, cz.y], [cx.z, cy.z, cz.z]];
  const tr = m[0][0] + m[1][1] + m[2][2];
  let x, y, z, w;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; w = 0.25 * s; x = (m[2][1] - m[1][2]) / s; y = (m[0][2] - m[2][0]) / s; z = (m[1][0] - m[0][1]) / s; }
  else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) { const s = Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]) * 2; w = (m[2][1] - m[1][2]) / s; x = 0.25 * s; y = (m[0][1] + m[1][0]) / s; z = (m[0][2] + m[2][0]) / s; }
  else if (m[1][1] > m[2][2]) { const s = Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]) * 2; w = (m[0][2] - m[2][0]) / s; x = (m[0][1] + m[1][0]) / s; y = 0.25 * s; z = (m[1][2] + m[2][1]) / s; }
  else { const s = Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]) * 2; w = (m[1][0] - m[0][1]) / s; x = (m[0][2] + m[2][0]) / s; y = (m[1][2] + m[2][1]) / s; z = 0.25 * s; }
  return qnorm({ x, y, z, w });
}

// ---- simulation ------------------------------------------------------------------------------
const DEFAULTS = {
  count: 6,
  size: 0.9,            // die side length (world units)
  tray: { halfX: 4.2, halfZ: 3.0 }, // inner half-extents of the walled tray on the floor
  gravity: 22,
  restitution: 0.32,    // bounciness of die/floor contacts
  restSlop: 1.0,        // closing speed below which restitution is dropped (kills micro-bouncing)
  friction: 0.5,        // Coulomb coefficient (drives the tumble)
  subDt: 1 / 240,       // physics substep
  frameDt: 1 / 60,      // trajectory sample cadence
  maxTime: 5,           // hard cap before force-settling
  penSlop: 0.005,       // penetration tolerated before positional correction kicks in
  sleepLin: 0.14,       // |v| below this ...
  sleepAng: 0.4,        // ... and |ω| below this counts as still
  sleepTime: 0.2,       // ... sustained for this long → asleep
};

export function createDiceSim(userOpts = {}) {
  const o = { ...DEFAULTS, ...userOpts, tray: { ...DEFAULTS.tray, ...(userOpts.tray || {}) } };
  const S = o.size, H = S / 2;
  const invM = 1;                     // mass 1
  const invI = 6 / (S * S);           // uniform cube: I = m·S²/6, isotropic → scalar inverse
  const rBall = H * 1.15;             // die–die sphere radius (sphere stage of the plan)

  // Inward-facing planes containing the dice: floor + four tray walls. Each is { n, offset } with the
  // allowed half-space being dot(point, n) >= offset.
  const planes = [
    { n: V(0, 1, 0), offset: 0 },                       // floor
    { n: V(1, 0, 0), offset: -o.tray.halfX },           // -X wall (points inward +X)
    { n: V(-1, 0, 0), offset: -o.tray.halfX },          // +X wall
    { n: V(0, 0, 1), offset: -o.tray.halfZ },           // -Z wall
    { n: V(0, 0, -1), offset: -o.tray.halfZ },          // +Z wall
  ];

  function seedDice(rng) {
    const dice = [];
    for (let i = 0; i < o.count; i++) {
      const p = V(
        (rng() * 2 - 1) * (o.tray.halfX - S),
        S * 1.2 + rng() * S * 2.5 + i * 0.05,           // start above the floor, slightly stacked in height
        (rng() * 2 - 1) * (o.tray.halfZ - S),
      );
      const v = V((rng() * 2 - 1) * 6, -2 - rng() * 3, (rng() * 2 - 1) * 6);
      const w = V((rng() * 2 - 1) * 14, (rng() * 2 - 1) * 14, (rng() * 2 - 1) * 14);
      const q = qnorm({ x: rng() * 2 - 1, y: rng() * 2 - 1, z: rng() * 2 - 1, w: rng() * 2 - 1 });
      dice.push({ p, v, q, w, asleepFor: 0 });
    }
    return dice;
  }

  // Resolve one OBB corner touching a plane: normal impulse (with restitution) + clamped friction.
  function resolvePlaneContact(d, r, worldCorner, plane) {
    const pen = plane.offset - vdot(worldCorner, plane.n); // >0 ⇒ penetrating
    if (pen <= 0) return 0;
    const n = plane.n;
    const vp = vadd(d.v, vcross(d.w, r));                   // velocity at the contact point
    const vn = vdot(vp, n);
    if (vn < 0) {                                           // only if closing
      // Effective mass along n: invM + n·((I⁻¹(r×n))×r), which for isotropic inertia is invM+invI|r×n|².
      const rn = vcross(r, n);
      const k = invM + invI * vdot(rn, rn);
      // Drop restitution for slow (resting) contacts so the die stops bouncing and can go to sleep.
      const e = -vn < o.restSlop ? 0 : o.restitution;
      const jn = -(1 + e) * vn / k;
      applyImpulse(d, r, vscale(n, jn));
      // friction
      const vp2 = vadd(d.v, vcross(d.w, r));
      const vt = vsub(vp2, vscale(n, vdot(vp2, n)));
      const vtl = vlen(vt);
      if (vtl > 1e-6) {
        const t = vscale(vt, 1 / vtl);
        const rt = vcross(r, t);
        const kt = invM + invI * vdot(rt, rt);
        let jt = -vdot(vp2, t) / kt;
        const max = o.friction * jn;
        jt = Math.max(-max, Math.min(max, jt));
        applyImpulse(d, r, vscale(t, jt));
      }
    }
    return pen;
  }

  function applyImpulse(d, r, j) {
    d.v = vadd(d.v, vscale(j, invM));
    d.w = vadd(d.w, vscale(vcross(r, j), invI));
  }

  // Die–die collision handled at the SPHERE stage: bounding spheres, positional split + impulse with
  // a little friction so contacts impart spin. (Full OBB–OBB is the next stage of the plan.)
  function resolvePair(a, b) {
    const d = vsub(b.p, a.p);
    const dist = vlen(d);
    const min = 2 * rBall;
    if (dist >= min || dist < 1e-9) return;
    const n = vscale(d, 1 / dist);
    // positional split
    const push = (min - dist) * 0.5;
    a.p = vsub(a.p, vscale(n, push));
    b.p = vadd(b.p, vscale(n, push));
    // impulse at the sphere surfaces
    const ra = vscale(n, rBall), rb = vscale(n, -rBall);
    const vpa = vadd(a.v, vcross(a.w, ra));
    const vpb = vadd(b.v, vcross(b.w, rb));
    const rel = vsub(vpb, vpa);
    const vn = vdot(rel, n);
    if (vn >= 0) return;
    const rna = vcross(ra, n), rnb = vcross(rb, n);
    const k = 2 * invM + invI * (vdot(rna, rna) + vdot(rnb, rnb));
    const jn = -(1 + o.restitution) * vn / k;
    const J = vscale(n, jn);
    applyImpulse(a, ra, vscale(J, -1));
    applyImpulse(b, rb, J);
  }

  function step(dice, dt) {
    // 1) gravity
    for (const d of dice) d.v = vadd(d.v, V(0, -o.gravity * dt, 0));
    // 2) contacts (a few sequential-impulse iterations for stability)
    for (let iter = 0; iter < 4; iter++) {
      for (const d of dice) {
        for (const c of CORNERS) {
          const local = V(c.x * H, c.y * H, c.z * H);
          const world = vadd(d.p, qrot(d.q, local));
          const r = vsub(world, d.p);
          for (const plane of planes) resolvePlaneContact(d, r, world, plane);
        }
      }
      for (let i = 0; i < dice.length; i++)
        for (let j = i + 1; j < dice.length; j++) resolvePair(dice[i], dice[j]);
    }
    // 3) integrate + light damping
    for (const d of dice) {
      d.v = vscale(d.v, 0.999);
      d.w = vscale(d.w, 0.995);
      d.p = vadd(d.p, vscale(d.v, dt));
      const wq = { x: d.w.x, y: d.w.y, z: d.w.z, w: 0 };
      const dq = qmul(wq, d.q);
      d.q = qnorm({ x: d.q.x + 0.5 * dq.x * dt, y: d.q.y + 0.5 * dq.y * dt, z: d.q.z + 0.5 * dq.z * dt, w: d.q.w + 0.5 * dq.w * dt });
    }
    // 4) positional correction: lift each die out of its deepest floor/wall penetration
    for (const d of dice) {
      for (const plane of planes) {
        let maxPen = 0;
        for (const c of CORNERS) {
          const world = vadd(d.p, qrot(d.q, V(c.x * H, c.y * H, c.z * H)));
          maxPen = Math.max(maxPen, plane.offset - vdot(world, plane.n));
        }
        if (maxPen > o.penSlop) d.p = vadd(d.p, vscale(plane.n, (maxPen - o.penSlop) * 0.4));
      }
    }
  }

  function allAsleep(dice, dt) {
    let asleep = true;
    for (const d of dice) {
      if (vlen(d.v) < o.sleepLin && vlen(d.w) < o.sleepAng) d.asleepFor += dt;
      else d.asleepFor = 0;
      if (d.asleepFor < o.sleepTime) asleep = false;
    }
    return asleep;
  }

  // Snap a settled die to a flat rest pose and drop it exactly onto the floor.
  function settle(d) {
    d.q = snapQuat(d.q);
    d.v = V(); d.w = V();
    let minY = Infinity;
    for (const c of CORNERS) minY = Math.min(minY, vadd(d.p, qrot(d.q, V(c.x * H, c.y * H, c.z * H))).y);
    d.p = V(d.p.x, d.p.y - minY, d.p.z); // rest the lowest corner on y = 0
  }

  return {
    size: S,
    tray: o.tray,
    faces: FACES,
    // Run a full throw. Returns { values, frames, steps }. `frames` is an array of samples; each
    // sample is an array of { p:{x,y,z}, q:{x,y,z,w} } — one per die — at 1/60s spacing.
    simulate(seed = 1) {
      const rng = mulberry32(seed >>> 0);
      const dice = seedDice(rng);
      const frames = [];
      const snapshot = () => frames.push(dice.map((d) => ({ p: { ...d.p }, q: { ...d.q } })));
      const subPerFrame = Math.max(1, Math.round(o.frameDt / o.subDt));
      snapshot();
      let t = 0, settledAt = -1;
      const maxSteps = Math.ceil(o.maxTime / o.subDt);
      for (let s = 0; s < maxSteps; s++) {
        step(dice, o.subDt);
        t += o.subDt;
        if (s % subPerFrame === subPerFrame - 1) snapshot();
        if (allAsleep(dice, o.subDt)) { settledAt = t; break; }
      }
      for (const d of dice) settle(d);
      snapshot(); // final rest pose
      return {
        values: dice.map((d) => readUpValue(d.q)),
        frames,
        steps: frames.length,
        settledAt: settledAt < 0 ? o.maxTime : settledAt,
      };
    },
  };
}
