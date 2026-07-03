// trickshots.js — the "Trick Shots" mode: a solo, level-based challenge with rising difficulty and
// NO game rules (no fouls, no turns) — every shot is legal, jump shots included. It layers on the same
// deterministic engine as the games; a level is just a fixed layout + a machine-checkable GOAL, and a
// shot passes the level when simulate()'s result satisfies that goal.
//
// Two sources of levels, both SOLVABILITY-GUARANTEED the same way the 147 exhibition is: we never ship
// a layout we can't prove beatable. `findSolution` searches the engine for a shot that meets the goal;
// the curated famous shots and every procedurally-generated level are only accepted once a solution is
// found, and the test suite re-derives one for each. So a "Show me" hint always exists.
//
// "Cues as rails": the engine already takes a `layout.rails` override (straight cushion cylinders), so a
// cue stick laid on the bed is just another finite rail the ball banks off — zero physics changes. A
// level's optional `rails: [cueRail(...)]` are appended to the table's own cushions.

import * as v3 from './vec3.js';
import { Ball } from './motion.js';
import { simulate } from './simulate.js';
import { railCylinders } from './table.js';
import { snooker } from './variants/snooker.js';
import { pool } from './variants/pool.js';
import { MAX_SPEED, GRAVITY } from './snooker.js';

const TABLES = { snooker, pool };
const clampSpeed = (s) => Math.min(MAX_SPEED, Math.max(0.3, s));

// --- geometry helpers ------------------------------------------------------------------------

// Everything a level needs from its table: ball radius, play bounds, pockets, and the table's own
// straight-rail cushions (so a level's extra cue-rails append to, not replace, the real cushions).
export function tableGeom(tableId) {
  const variant = TABLES[tableId] ?? pool;
  const R = variant.ball.radius;
  const bounds = variant.bounds();
  const pockets = variant.pockets();
  return { variant, R, mass: variant.ball.mass, bounds, pockets, rails: railCylinders(R, bounds, pockets) };
}

const mkBall = (g, p) =>
  new Ball({ id: p.id, kind: p.kind ?? (p.id === 'cue' ? 'cue' : 'object'), color: p.color, radius: g.R, mass: g.mass, pos: v3.vec(p.pos.x, p.pos.y, g.R), spin: v3.vec(0, 0, 0) });

// A cue stick laid on the bed, acting as a straight rail the ball banks off. `axis` is the direction it
// runs ('x' or 'y'); `perp` its position on the other axis; `span` its extent along `axis`. It borrows
// the table cushion's tilt (z, rc) so banks behave like a familiar cushion. approachSide (+1/-1) only
// tunes the one-sided guard; the cylinder test itself is two-sided, so it reflects from either face.
export function cueRail(g, axis, perp, span, approachSide = 1) {
  const proto = g.rails[0]; // share the table cushions' nose tilt + tube radius for consistent banks
  return { axis, perp, perpSign: approachSide, z: proto.z, rc: proto.rc, span: [Math.min(...span), Math.max(...span)], isCue: true };
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const inBounds = (g, p, m = 0.02) => p.x > g.bounds.minX + g.R + m && p.x < g.bounds.maxX - g.R - m && p.y > g.bounds.minY + g.R + m && p.y < g.bounds.maxY - g.R - m;

// Is the segment A→B clear of every listed ball centre (ignoring `skip` ids) by `clr`? (from exhibition)
function segClear(A, B, pieces, skip, clr) {
  for (const b of pieces) {
    if (skip.includes(b.id)) continue;
    const dx = B.x - A.x, dy = B.y - A.y;
    const L2 = dx * dx + dy * dy;
    let t = L2 > 0 ? ((b.pos.x - A.x) * dx + (b.pos.y - A.y) * dy) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    if (Math.hypot(b.pos.x - (A.x + t * dx), b.pos.y - (A.y + t * dy)) < clr) return false;
  }
  return true;
}

export function pocketName(g, index) {
  const p = g.pockets[index]?.center;
  if (!p) return 'a pocket';
  const midX = Math.abs(p.x) < 1e-6;
  const v = p.y > 0 ? 'top' : 'bottom';
  return midX ? `${v}-middle` : `${v}-${p.x < 0 ? 'left' : 'right'}`;
}

// --- goal predicates over a simulate() result ------------------------------------------------
// Composable, serialisable-ish checks the UI can also describe. A level's `goal(res)` is built from these.

export const potted = (res, id) => res.pocketed.includes(id);
export const pottedAll = (res, ids) => ids.every((id) => res.pocketed.includes(id));
export const cueSafe = (res) => !res.pocketed.includes('cue') && !res.cleared.includes('cue');

// Which pocket a given ball dropped into (by index into the table's pocket list), or -1.
export function pottedIntoIndex(res, id) {
  for (const e of res.timeline) if (e.kind === 'pocket' && e.hit && e.hit.id === id) return e.pocketIndex;
  return -1;
}
// Did `id` (default the cue) go airborne at any point — i.e. a genuine jump shot? NOTE: this is TRUE
// even for a sub-millimetre cushion hop, so it's too weak to define a "jump level" — use leapt() for that.
export function jumped(res, id = 'cue') {
  for (const e of res.timeline) { const b = e.balls.find((x) => x.id === id); if (b && b.phase === 'flight') return true; }
  return false;
}
// A REAL leap: the ball's centre rises to ≥ ~2.4R above the bed (rest is R) — high enough to clear a
// ball, not the trivial hop a firm cushion contact produces. This is what a jump LEVEL must require, so
// the solver can't satisfy it with a flat shot.
export function leapt(res, R, id = 'cue') {
  let maxZ = 0;
  for (const e of res.timeline) { const b = e.balls.find((x) => x.id === id); if (b && b.pos.z > maxZ) maxZ = b.pos.z; }
  return maxZ >= 2.4 * R;
}
// Did the cue bank off one of the LAID CUE STICKS (not a table cushion)? At a rail-contact event the
// ball centre sits ~R+rc from the rail axis; check that point lies on a cue-stick segment. This lets a
// cue-rail level demand the stick is actually used, instead of any old cushion bank.
export function bankedOffCue(res, cueRails, R, id = 'cue') {
  for (const e of res.timeline) {
    if (e.kind !== 'rail' || !e.hit || e.hit.id !== id) continue;
    const b = e.balls.find((x) => x.id === id);
    if (!b) continue;
    for (const r of cueRails) {
      const tol = R + (r.rc || 0) + 0.4 * R;
      const along = r.axis === 'x' ? b.pos.x : b.pos.y;
      const perp = r.axis === 'x' ? b.pos.y : b.pos.x;
      if (along >= r.span[0] - tol && along <= r.span[1] + tol && Math.abs(perp - r.perp) <= tol) return true;
    }
  }
  return false;
}
// A plant/combo: the cue's FIRST object-ball contact was NOT the ball that ended up potted.
export function comboed(res, pottedId, cueId = 'cue') {
  return res.pocketed.includes(pottedId) && res.firstContact && res.firstContact !== pottedId;
}
// The cue banked off a rail (cushion OR a cue-stick) BEFORE it first touched any object ball.
export function bankedBeforeContact(res, cueId = 'cue') {
  for (const e of res.timeline) {
    if (e.kind === 'rail' && e.hit && e.hit.id === cueId) return true;
    if (e.kind === 'pair' && e.hit && (e.hit.a === cueId || e.hit.b === cueId)) return false;
  }
  return false;
}
// The OBJECT ball `id` banked off a rail before dropping — the defining feature of a "double".
export function objectBanked(res, id) {
  let railed = false;
  for (const e of res.timeline) {
    if (e.kind === 'rail' && e.hit && e.hit.id === id) railed = true;
    if (e.kind === 'pocket' && e.hit && e.hit.id === id) return railed;
  }
  return false;
}

// --- running a shot on a level ---------------------------------------------------------------

// Resolve one cue strike against a level's layout (table cushions + any cue-rails), rules-free.
export function runTrickShot(level, shot) {
  const g = tableGeom(level.table);
  const balls = level.pieces.map((p) => mkBall(g, p));
  const rails = level.rails && level.rails.length ? [...g.rails, ...level.rails] : g.rails;
  return simulate(
    { balls, bounds: g.bounds, pockets: g.pockets, rails },
    { ballId: 'cue', angle: shot.angle, speed: clampSpeed(shot.speed), spin: shot.spin ?? { side: 0, vert: 0 }, elevation: shot.elevation ?? 0 },
    { contactBall: 'cue' },
  );
}

// --- solution search (proves a level is beatable, and powers the "Show me" hint) ---------------
// Staged, cheapest-first, returns the first shot whose result satisfies level.goal:
//   A — direct: ghost-ball aim at each target→pocket (pots, cuts, plants, straight "alley" shots)
//   B — jump: the same aims but with cue elevation (leapfrog over a blocking ball)
//   C — bank: mirror the ghost across each cue-rail / cushion line for a one-bounce banked pot
// Each stage stops at the first goal-satisfying shot, so easy levels cost almost nothing.

const SPEEDS = [2.4, 3.1, 4.0, 5.2, 6.4];
const SPINS = [{ side: 0, vert: 0 }, { side: 0, vert: 0.5 }, { side: 0, vert: -0.4 }, { side: 0.35, vert: 0 }, { side: -0.35, vert: 0 }];
const MAX_JUMP_ELEV = Math.PI / 3; // 60°, matching the renderer's human cue-lift cap

const cue = (pieces) => pieces.find((p) => p.id === 'cue');
const objects = (pieces) => pieces.filter((p) => p.id !== 'cue');

// Ghost-ball contact point: where the cue's centre must be at impact to send T toward pocket P.
export function ghost(T, P, R) {
  const d = dist(T.pos, P.center);
  if (d < 1e-6) return null;
  const u = { x: (P.center.x - T.pos.x) / d, y: (P.center.y - T.pos.y) / d };
  return { x: T.pos.x - 2 * R * u.x, y: T.pos.y - 2 * R * u.y };
}

// Every (target, pocket) whose ball→pocket path is clear — the shots worth aiming at.
function openLines(g, pieces) {
  const out = [];
  for (const T of objects(pieces)) {
    for (let pi = 0; pi < g.pockets.length; pi++) {
      const P = g.pockets[pi];
      if (dist(T.pos, P.center) < 0.12) continue;
      if (!segClear(T.pos, P.center, pieces, [T.id], g.R + 0.004)) continue;
      out.push({ T, pi, P, gh: ghost(T, P, g.R) });
    }
  }
  return out;
}

function tryShot(level, goal, angle, speed, spin, elevation) {
  const res = runTrickShot(level, { angle, speed, spin, elevation });
  return goal(res) ? { angle, speed, spin, elevation } : null;
}

// Analytic jump seed: a blocker on the cue→ghost line forces a leap. An elevated strike launches the
// cue as a projectile p(t) = P + V·t + ½g·t² with V = speed·(cosE·aim, sinE) — a parabola (engine.strike
// / motion FLIGHT). For a shot that lands back at bed level a horizontal distance D away (range =
// speed²·sin2E / g), the arc height at along-line distance x is h(x) = tanE · x·(D−x)/D. So the elevation
// that just clears a blocker of required height hNeed at distance `along` is tanE = hNeed·D / (along·(D−along)),
// and the speed follows from the range. We take the tallest-required blocker, add a little margin, and
// return {angle, speed, elevation} to seed the search — no elevation sweep needed. null if nothing blocks.
export function jumpSeed(geom, C, G, pieces, targetId) {
  const dxg = G.x - C.x, dyg = G.y - C.y;
  const D = Math.hypot(dxg, dyg);
  if (D < 3 * geom.R) return null;
  const ux = dxg / D, uy = dyg / D;
  const hNeed = 2 * geom.R + 0.006; // cue centre must clear a blocker centre by 2R (+ a small margin)
  let tanE = 0;
  for (const p of pieces) {
    if (p.id === 'cue' || p.id === targetId) continue;
    const dx = p.pos.x - C.x, dy = p.pos.y - C.y;
    const along = dx * ux + dy * uy;          // projection onto the aim line
    const lat = Math.abs(-dx * uy + dy * ux); // perpendicular distance from the line
    if (along <= geom.R || along >= D || lat >= 2 * geom.R) continue; // not in the flight corridor
    const need = (hNeed * D) / (along * (D - along)); // tanE to clear this ball (parabola landing at D)
    if (need > tanE) tanE = need;
  }
  if (tanE <= 0) return null; // clear line — no jump required
  const E = Math.min(Math.atan(tanE * 1.12), MAX_JUMP_ELEV); // a touch over the minimum, capped at 60°
  const speed = clampSpeed(Math.sqrt((GRAVITY * D) / Math.sin(2 * E)));
  return { angle: Math.atan2(dyg, dxg), speed, elevation: E };
}

// Refine around a seed aim: a few sub-degree nudges × the speed/spin menu (or a fixed set).
function refine(level, goal, seedAim, { speeds = SPEEDS, spins = SPINS, elevs = [0] } = {}) {
  for (const da of [0, 0.012, -0.012, 0.028, -0.028, 0.05, -0.05]) {
    for (const elevation of elevs) {
      for (const speed of speeds) {
        for (const spin of spins) {
          const hit = tryShot(level, goal, seedAim + da, speed, spin, elevation);
          if (hit) return hit;
        }
      }
    }
  }
  return null;
}

export function findSolution(level) {
  const g = tableGeom(level.table);
  const C = cue(level.pieces);
  if (!C) return null;
  const goal = level.goal;
  const lines = openLines(g, level.pieces);

  // Stage A — direct pot / cut / plant, no elevation.
  for (const ln of lines) {
    if (!ln.gh) continue;
    const seed = Math.atan2(ln.gh.y - C.pos.y, ln.gh.x - C.pos.x);
    const hit = refine(level, goal, seed, { elevs: [0] });
    if (hit) return hit;
  }

  // Stage B — jump (ANALYTIC): solve the projectile that clears the blocker(s) on the cue→ghost line
  // and lands at the ghost, then seed the search there. Speed multipliers < 1 land the ball short so it
  // rolls into contact (the bed bounce is damped); elevation nudges absorb the seed's approximations.
  for (const ln of lines) {
    if (!ln.gh) continue;
    const js = jumpSeed(g, C.pos, ln.gh, level.pieces, ln.T.id);
    if (!js) continue;
    const speeds = [0.8, 0.92, 1, 1.15, 1.32].map((k) => clampSpeed(js.speed * k));
    const elevs = [0.9, 1, 1.12].map((k) => Math.min(js.elevation * k, MAX_JUMP_ELEV));
    const hit = refine(level, goal, js.angle, { speeds, spins: [{ side: 0, vert: 0 }, { side: 0, vert: 0.3 }], elevs });
    if (hit) return hit;
  }

  // Stage C — bank: mirror each open ghost across every rail line (cushions + cue-rails) for a
  // one-bounce banked pot. An axis-aligned rail at perp p mirrors a point across that line.
  const railLines = [
    ...(level.rails ?? []),
    // the four cushion faces as mirror lines, so a plain cushion bank is found too
    { axis: 'x', perp: g.bounds.maxY - g.R }, { axis: 'x', perp: g.bounds.minY + g.R },
    { axis: 'y', perp: g.bounds.maxX - g.R }, { axis: 'y', perp: g.bounds.minX + g.R },
  ];
  for (const rl of railLines) {
    for (const ln of lines) {
      if (!ln.gh) continue;
      const mirror = rl.axis === 'x' ? { x: ln.gh.x, y: 2 * rl.perp - ln.gh.y } : { x: 2 * rl.perp - ln.gh.x, y: ln.gh.y };
      const seed = Math.atan2(mirror.y - C.pos.y, mirror.x - C.pos.x);
      const hit = refine(level, goal, seed, { spins: [{ side: 0, vert: 0 }], speeds: [3.2, 4.2, 5.4, 6.5] });
      if (hit) return hit;
    }
  }

  // Stage D — object-ball bank ("the double"): mirror each POCKET across each cushion line, aim the
  // target at the virtual pocket so it banks off the cushion into the real one. Direct cue→ghost aim.
  const mirrorPocket = (rl, P) => (rl.axis === 'x' ? { x: P.x, y: 2 * rl.perp - P.y } : { x: 2 * rl.perp - P.x, y: P.y });
  for (const T of objects(level.pieces)) {
    for (const rl of railLines) {
      for (let pi = 0; pi < g.pockets.length; pi++) {
        const vP = mirrorPocket(rl, g.pockets[pi].center);
        const gh = ghost(T, { center: vP }, g.R); // where the cue must send T so it heads at the virtual pocket
        if (!gh) continue;
        if (!segClear(C.pos, gh, level.pieces, ['cue', T.id], 1.9 * g.R)) continue;
        const seed = Math.atan2(gh.y - C.pos.y, gh.x - C.pos.x);
        const hit = refine(level, goal, seed, { spins: [{ side: 0, vert: 0 }], speeds: [3.4, 4.4, 5.6, 6.6] });
        if (hit) return hit;
      }
    }
  }
  return null;
}

// --- curated famous trick shots --------------------------------------------------------------
// Hand-placed layouts of classic shots. Positions are chosen to be solvable; findSolution derives the
// actual stroke (and the test asserts one exists), so these need no stored shot params.

const POOL = tableGeom('pool');
const RP = POOL.R;

// "The Sledgehammer" — three balls in a dead-straight line at a pocket; one firm stroke plants the
// front ball in. Classic combination/plant.
function sledgehammer() {
  const P = POOL.pockets[3].center; // top-right corner
  const b1 = { x: P.x - 0.30, y: P.y - 0.22 }; // front ball, nearest the pocket
  const uGP = { x: P.x - b1.x, y: P.y - b1.y }; const l = Math.hypot(uGP.x, uGP.y);
  const ux = uGP.x / l, uy = uGP.y / l; // unit b1→pocket
  const gap = 2 * RP + 0.0005;
  // b2, b3 laid back-to-back BEHIND b1, in line with the pocket → a firm hit plants b1 straight in
  const b2 = { x: b1.x - gap * ux, y: b1.y - gap * uy };
  const b3 = { x: b1.x - 2 * gap * ux, y: b1.y - 2 * gap * uy };
  const pieces = [
    { id: 'cue', color: '#f5f3ea', pos: { x: b3.x - 0.6 * ux, y: b3.y - 0.6 * uy } },
    { id: 'b1', number: 1, color: '#e7c63b', pos: b1 },
    { id: 'b2', number: 2, color: '#2156b0', pos: b2 },
    { id: 'b3', number: 3, color: '#c0241f', pos: b3 },
  ];
  return { id: 'sledgehammer', name: 'The Sledgehammer', table: 'pool',
    objective: 'One stroke, three balls in a line — plant the front ball into the top-right pocket.',
    pieces, goal: (res) => potted(res, 'b1') && cueSafe(res) };
}

// "The Leapfrog" — a blocker ball sits square on the line to the object ball; jump the cue over it.
function leapfrog() {
  const g = POOL;
  const P = g.pockets[3].center; // top-right
  const T = { x: P.x - 0.24, y: P.y - 0.18 };
  const C = { x: T.x - 0.9, y: T.y - 0.34 };
  const mid = { x: (C.x + T.x) / 2, y: (C.y + T.y) / 2 }; // blocker dead on the aim line
  const pieces = [
    { id: 'cue', color: '#f5f3ea', pos: C },
    { id: 'b8', number: 8, color: '#1a1a1a', pos: { x: T.x, y: T.y } },
    { id: 'blk', number: 5, color: '#e07b1a', pos: mid },
  ];
  return { id: 'leapfrog', name: 'The Leapfrog', table: 'pool',
    objective: 'A ball blocks the path — jump the cue over it and pot the 8 in the top-right.',
    pieces, goal: (res) => potted(res, 'b8') && leapt(res, g.R) && cueSafe(res) };
}

// "The Guardrail" — a cue stick laid across the table; bank the cue ball off it into the pocket.
function guardrail() {
  const g = POOL;
  const P = g.pockets[2].center; // top-left corner
  const T = { x: P.x + 0.22, y: P.y - 0.16 };
  // a horizontal cue-stick low in the table; the cue sits below it and must bank UP off it into T's line
  const railY = 0.05;
  const rail = cueRail(g, 'x', railY, [-0.55, 0.15], 1);
  const C = { x: T.x + 0.5, y: -0.30 };
  return { id: 'guardrail', name: 'The Guardrail', table: 'pool',
    objective: 'Bank the cue ball off the laid cue stick and pot the ball in the top-left.',
    pieces: [
      { id: 'cue', color: '#f5f3ea', pos: C },
      { id: 'b3', number: 3, color: '#c0241f', pos: { x: T.x, y: T.y } },
    ],
    rails: [rail],
    goal: (res) => potted(res, 'b3') && bankedOffCue(res, [rail], g.R) && cueSafe(res) };
}

// "The Alley" — two parallel cue sticks form a channel; fire the cue straight down it to pot the ball,
// the sticks keeping a slightly-off stroke honest.
function alley() {
  const g = POOL;
  const P = g.pockets[3].center; // top-right
  const T = { x: P.x - 0.20, y: P.y - 0.14 };
  const C = { x: -0.7, y: 0.0 };
  // channel runs roughly along the cue→T line; place two rails either side of y≈0 heading right
  const lo = -0.5, hi = 0.55;
  const rails = [cueRail(g, 'x', 0.075, [lo, hi], -1), cueRail(g, 'x', -0.075, [lo, hi], 1)];
  return { id: 'alley', name: 'The Alley', table: 'pool',
    objective: 'Fire the cue ball down the channel of cues and pot the ball top-right.',
    pieces: [
      { id: 'cue', color: '#f5f3ea', pos: C },
      { id: 'b7', number: 7, color: '#1f7a43', pos: { x: T.x, y: T.y } },
    ],
    rails,
    goal: (res) => potted(res, 'b7') && bankedOffCue(res, rails, g.R) && cueSafe(res) };
}

// "The Double" — bank the OBJECT ball off a cushion and back across the table into a corner pocket.
function double() {
  const g = POOL;
  const T = { x: 0.42, y: 0.10 }; // sits below the top cushion, out toward the right
  const C = { x: -0.05, y: -0.05 }; // cue behind and below, a clear line to drive T up into the cushion
  return { id: 'double', name: 'The Double', table: 'pool',
    objective: 'Bank the object ball off the top cushion and down into a bottom corner pocket.',
    pieces: [
      { id: 'cue', color: '#f5f3ea', pos: C },
      { id: 'b4', number: 4, color: '#6a3da8', pos: T },
    ],
    goal: (res) => potted(res, 'b4') && objectBanked(res, 'b4') && cueSafe(res) };
}

export const CURATED = [sledgehammer(), leapfrog(), guardrail(), alley(), double()];

// --- procedural generation -------------------------------------------------------------------
// Constructive, not random-and-pray: build a layout AROUND an intended shot type scaled by difficulty,
// then require findSolution to confirm it — regenerating until one is beatable. Difficulty raises the
// cut angle, distance, ball count, and unlocks harder goal types (named pocket → plant → jump).

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Goal types unlocked as difficulty climbs.
function goalTypeFor(difficulty, rng) {
  const bag = ['pot'];
  if (difficulty >= 2) bag.push('named');
  if (difficulty >= 3) bag.push('plant');
  if (difficulty >= 4) bag.push('jump');
  return bag[Math.floor(rng() * bag.length)];
}

function placeClear(g, pieces, rng, near = null, spread = 0.9) {
  for (let tries = 0; tries < 200; tries++) {
    const x = near ? near.x + (rng() - 0.5) * spread : (g.bounds.minX + g.R) + rng() * (g.bounds.maxX - g.bounds.minX - 2 * g.R);
    const y = near ? near.y + (rng() - 0.5) * spread : (g.bounds.minY + g.R) + rng() * (g.bounds.maxY - g.bounds.minY - 2 * g.R);
    const p = { x, y };
    if (!inBounds(g, p, 0.03)) continue;
    if (g.pockets.some((pk) => dist(p, pk.center) < 0.12)) continue;
    if (pieces.some((q) => dist(p, q.pos) < 2.2 * g.R)) continue;
    return p;
  }
  return null;
}

const COLORS = ['#e7c63b', '#2156b0', '#c0241f', '#6a3da8', '#e07b1a', '#1f7a43', '#7a1f2b'];

// Build ONE candidate level for a goal type; returns { level } or null if geometry didn't come together.
function buildCandidate(table, goalType, difficulty, rng) {
  const g = tableGeom(table);
  const tight = Math.min(0.55, 0.12 + difficulty * 0.05); // higher difficulty → longer target→pocket range
  const pi = Math.floor(rng() * g.pockets.length);
  const P = g.pockets[pi];
  // target a clear distance in front of the chosen pocket, biased toward the table interior
  const inward = { x: Math.sign(-P.center.x || -1), y: Math.sign(-P.center.y || -1) };
  const T = { x: P.center.x + inward.x * (0.16 + tight) * (0.6 + rng() * 0.6), y: P.center.y + inward.y * (0.16 + tight) * (0.6 + rng() * 0.6) };
  if (!inBounds(g, T, 0.03)) return null;
  const pieces = [{ id: 'target', number: 1 + Math.floor(rng() * 7), color: COLORS[Math.floor(rng() * COLORS.length)], pos: T }];

  // the cue: placed so the cut angle to the ghost stays within a difficulty-scaled bound
  const gh = ghost({ pos: T }, P, g.R);
  let C = null;
  for (let tries = 0; tries < 120; tries++) {
    const ang = rng() * Math.PI * 2;
    const d = 0.4 + rng() * 0.8;
    const cand = { x: gh.x + Math.cos(ang) * d, y: gh.y + Math.sin(ang) * d };
    if (!inBounds(g, cand, 0.03) || dist(cand, T) < 0.2) continue;
    // cut angle = angle between (cue→ghost) and (ghost→pocket)
    const uCG = { x: gh.x - cand.x, y: gh.y - cand.y }; const lcg = Math.hypot(uCG.x, uCG.y);
    const uGP = { x: P.center.x - T.x, y: P.center.y - T.y }; const lgp = Math.hypot(uGP.x, uGP.y);
    const cos = (uCG.x * uGP.x + uCG.y * uGP.y) / (lcg * lgp);
    const minCos = 0.92 - difficulty * 0.06; // easier levels demand a straighter shot
    if (cos < Math.max(0.35, minCos)) continue;
    if (!segClear(cand, gh, [{ id: 'target', pos: T }], ['target'], 1.9 * g.R)) continue;
    C = cand; break;
  }
  if (!C) return null;
  pieces.push({ id: 'cue', color: '#f5f3ea', pos: C });

  const level = { id: `gen-${goalType}-${difficulty}`, table, difficulty, generated: true, pieces, rails: [] };

  if (goalType === 'pot') {
    level.objective = `Pot the ball in the ${pocketName(g, pi)}.`;
    level.goal = (res) => potted(res, 'target') && cueSafe(res);
  } else if (goalType === 'named') {
    level.objective = `Pot the ball specifically in the ${pocketName(g, pi)} pocket.`;
    level.goal = (res) => pottedIntoIndex(res, 'target') === pi && cueSafe(res);
  } else if (goalType === 'plant') {
    // insert a plant ball between the cue line and the target, in line with the pocket, so the cue
    // strikes the plant, which pots the target
    const uGP = { x: (P.center.x - T.x), y: (P.center.y - T.y) }; const l = Math.hypot(uGP.x, uGP.y);
    const plant = { x: T.x - (2 * g.R + 0.001) * uGP.x / l, y: T.y - (2 * g.R + 0.001) * uGP.y / l };
    if (!inBounds(g, plant, 0.03)) return null;
    // move the cue behind the plant, in line
    const cueBehind = { x: plant.x - 0.5 * uGP.x / l, y: plant.y - 0.5 * uGP.y / l };
    if (!inBounds(g, cueBehind, 0.03)) return null;
    pieces.find((p) => p.id === 'cue').pos = cueBehind;
    pieces.push({ id: 'plant', number: 2 + Math.floor(rng() * 6), color: COLORS[Math.floor(rng() * COLORS.length)], pos: plant });
    level.objective = `A plant — strike the near ball to pot the far one in the ${pocketName(g, pi)}.`;
    level.goal = (res) => potted(res, 'target') && cueSafe(res);
  } else if (goalType === 'jump') {
    // a blocker square on the cue→ghost line forces a jump over it
    const mid = { x: (C.x + gh.x) / 2, y: (C.y + gh.y) / 2 };
    if (pieces.some((q) => q.id !== 'cue' && dist(q.pos, mid) < 2.2 * g.R)) return null;
    if (!inBounds(g, mid, 0.03)) return null;
    pieces.push({ id: 'blocker', number: 4 + Math.floor(rng() * 4), color: COLORS[Math.floor(rng() * COLORS.length)], pos: mid });
    level.objective = `Jump the cue over the blocker and pot the ball in the ${pocketName(g, pi)}.`;
    level.goal = (res) => potted(res, 'target') && leapt(res, g.R) && cueSafe(res);
  }
  return level;
}

// Generate the next solvable level at a given difficulty. Deterministic in (difficulty, seed): tries a
// few candidate goal types/layouts and returns the first that findSolution confirms beatable.
export function generateLevel(difficulty, seed = 1) {
  const rng = mulberry32((seed * 2654435761) ^ (difficulty * 40503));
  const table = 'pool'; // the classic trick-shot table; the level.table hook keeps other tables open for later
  for (let attempt = 0; attempt < 24; attempt++) {
    const goalType = goalTypeFor(difficulty, rng);
    const cand = buildCandidate(table, goalType, difficulty, rng);
    if (!cand) continue;
    const sol = findSolution(cand);
    if (sol) return { ...cand, solution: sol };
  }
  // fallback: an easy straight pot is always constructible
  for (let attempt = 0; attempt < 40; attempt++) {
    const cand = buildCandidate(table, 'pot', 1, rng);
    if (cand) { const sol = findSolution(cand); if (sol) return { ...cand, solution: sol }; }
  }
  return null;
}

// Tag pieces with the renderer-facing fields the variant appearance code reads (group for cue/label,
// a number for the decal) without the engine caring. Cheap, and keeps the level data engine-focused.
function forRenderer(level) {
  const pieces = level.pieces.map((p, i) => ({
    number: p.number ?? i, color: p.color, ...p,
    group: p.id === 'cue' ? 'cue' : (p.group ?? 'object'),
    kind: p.id === 'cue' ? 'cue' : (p.kind ?? 'object'),
  }));
  return { ...level, pieces };
}

// The mode's level sequence: the curated famous shots first (a showcase), then endless generated levels
// of rising difficulty. `index` is 0-based; `seed` varies the generated layouts run to run.
export function getLevel(index, seed = 1) {
  if (index < CURATED.length) return forRenderer({ ...CURATED[index], index });
  const difficulty = 1 + (index - CURATED.length); // ramps forever
  const lvl = generateLevel(difficulty, seed + index);
  return lvl ? forRenderer({ ...lvl, index }) : null;
}

export const CURATED_COUNT = CURATED.length;
