// engine.js — the event-driven loop for snooker (two-phase rolling balls).
//
// Identical in spirit to carrom's loop — pop the earliest predicted event, advance every ball
// to it along its closed-form plan, resolve, re-detect only the 1–2 balls whose velocity just
// changed — with two differences that the two-phase model forces:
//   • Each ball carries a motion PLAN (slide→roll) built at absolute time `t0`. Advancing a
//     ball EVALUATES its plan at (t − t0); it does NOT rebuild the plan (so the plan's internal
//     slide→roll transition is handled inside posAt/velAt, and other balls' cached events stay
//     valid). The plan is rebuilt only when a collision changes that ball's velocity/spin.
//   • Event detection runs per trajectory segment (motion.segments), so the slide→roll bend is
//     never an explicit event — it's baked into each ball's predicted wall/pair/pocket times.
//
// Emits a timeline of post-event snapshots (positions, velocities, spin) for replay.

import * as v from './vec2.js';
import { detectRail, detectJaw, detectPair, detectPocket, detectBed, detectCleared, detectFrame } from './events.js';
import { resolvePair3D, resolveRail, resolveJaw, resolveContact, resolveWall, resolvePocketRebound } from './collisions.js';
import { railCylinders, pocketJaws, bounds as defaultBounds } from './table.js';
import {
  BALL_RESTITUTION,
  CUSHION_RESTITUTION,
  BALL_FRICTION_T,
  CUSHION_FRICTION_T,
  BED_RESTITUTION,
  BED_FRICTION_T,
  BED_REST_SPEED,
  CUSHION_NOSE_DROP,
  CUSHION_RISE,
  POCKET_LIP_RISE,
  JAW_RESTITUTION,
  JAW_FRICTION_T,
  POCKET_REBOUND,
  SPIN_GAIN,
} from './snooker.js';
import { PHASE } from './motion.js';

const MAX_EVENTS = 100000;

const snap = (balls, t, kind, intensity = 0, hit = null) => ({
  t,
  kind, // 'start' | 'pair' | 'rail' | 'jaw' | 'frame' | 'bed' | 'pocket' | 'cleared' | 'end'
  intensity, // impact speed (m/s) — drives collision-sound volume
  hit, // ids involved: {a,b} for a pair, {id} for a rail/jaw/bed/pocket/cleared
  balls: balls.map((b) => ({
    id: b.id,
    pos: { x: b.pos.x, y: b.pos.y, z: b.pos.z ?? b.radius },
    vel: { x: b.vel.x, y: b.vel.y, z: b.vel.z ?? 0 },
    spin: { x: b.spin.x, y: b.spin.y, z: b.spin.z },
    phase: b.phase,
    pocketed: b.pocketed,
    cleared: b.cleared ?? false,
  })),
});

const stopAbs = (b) => b.t0 + b.plan.tStop; // absolute time this ball comes to rest
const isMoving = (b, t) => !b.pocketed && stopAbs(b) > t + 1e-12;

// Advance every active ball to absolute time T by evaluating its plan (no replan).
function advance(balls, T) {
  for (const b of balls) {
    if (b.pocketed) continue;
    const localT = T - b.t0;
    b.pos = b.posAt(localT);
    b.vel = b.velAt(localT);
    b.spin = b.spinAt(localT);
  }
}

// Convert a cue strike (direction + power + tip offset) into the cue ball's launch state.
//   spin = { side: −1..1 (left/right English), vert: −1..1 (draw/follow) }
//   elevation (radians, default 0): cue butt raised so the tip strikes DOWNWARD onto the ball.
//     The bed's upward reaction gives the ball vz = speed·sin(elevation); the horizontal drive is
//     speed·cos(elevation) along `angle`. elevation>0 ⇒ a JUMP SHOT (on-table→FLIGHT with no
//     scheduled self-event: replan sees vz>0 and builds a flight plan). This is the minimal
//     vertical-cue-angle→upward-velocity mapping; everything downstream is the generic 3D path.
export function strike(ball, angle, speed, spin = {}, elevation = 0) {
  const dir = v.fromAngle(angle); // horizontal unit direction
  const cosE = Math.cos(elevation);
  const sinE = Math.sin(elevation);
  ball.vel = { x: dir.x * speed * cosE, y: dir.y * speed * cosE, z: speed * sinE };
  const vert = spin.vert || 0;
  const side = spin.side || 0;
  // horizontal-axis spin along perp(dir): + = topspin/follow (same sense as natural roll)
  const sh = v.scale(v.perp(dir), (vert * SPIN_GAIN * speed) / ball.radius);
  ball.spin = { x: sh.x, y: sh.y, z: (side * SPIN_GAIN * speed) / ball.radius };
}

const KIND_RANK = { bed: 0, pocket: 1, cleared: 2, jaw: 3, rail: 4, frame: 5, pair: 6 };

const airborne = (b) => b.phase === PHASE.FLIGHT;

// layout: { balls: Ball[], pockets: [{center,radius}], rails?: railCylinders[] }
//   rails default to table.railCylinders(ballRadius); pass layout.rails to override.
// shot:   { ballId, angle, speed, spin:{side,vert}, elevation? } | null  (elevation>0 = jump shot)
export function runEngine(layout, shot, opts = {}) {
  // The loop runs to `cap`; a caller may pass a SMALLER opts.maxEvents (e.g. the renderer's
  // shallow trajectory preview). `hitCap` below deliberately reports only the hard MAX_EVENTS
  // safety ceiling, NOT a caller's smaller cap — so a truncated preview isn't flagged as runaway.
  const cap = opts.maxEvents ?? MAX_EVENTS;
  const wantTimeline = opts.timeline !== false;
  const contactBall = opts.contactBall ?? null; // track this ball's contacts (snooker/pool/carom)
  let firstContact = null;
  const cueContacts = []; // every ball `contactBall` touches, in order (for carom scoring)
  let cushionHits = 0; // how many cushions `contactBall` hits (for cushion-count games)
  const balls = layout.balls;
  const pocketList = layout.pockets;
  const tblBounds = layout.bounds ?? defaultBounds();
  const R0 = balls.length ? balls[0].radius : 0;
  // Straight-rail cushion cylinders + rounded pocket JAWS (Milestone C2), derived from the caller's
  // bounds + pockets so an "open" table (far bounds) yields far, effectively-absent rails. Built
  // once from the ball radius (uniform per game); a caller may override via layout.rails/jaws.
  const rails = layout.rails ?? (balls.length ? railCylinders(R0, layout.bounds, layout.pockets, CUSHION_NOSE_DROP) : []);
  const jaws = layout.jaws ?? (balls.length ? pocketJaws(R0, layout.bounds, layout.pockets, CUSHION_NOSE_DROP) : []);
  // Finite cushion height + pocket lip (Milestone C2), in absolute z. A ball whose centre is above
  // topZ clears the cushion/jaws; one whose centre is above lipZ over a mouth sails over instead of
  // being captured. Both are at ball-centre height (R) plus the configured rise.
  const topZ = R0 + CUSHION_RISE * R0;
  const lipZ = R0 + POCKET_LIP_RISE * R0;

  if (shot) {
    const cue = balls.find((b) => b.id === shot.ballId);
    if (!cue) throw new Error(`shot.ballId ${shot.ballId} not found`);
    strike(cue, shot.angle, shot.speed, shot.spin || {}, shot.elevation || 0);
    cue.replan();
    cue.t0 = 0;
  }

  let t = 0;
  const timeline = wantTimeline ? [snap(balls, 0, 'start')] : [];
  let count = 0;

  const N = balls.length;
  const evRail = new Array(N).fill(null);
  const evJaw = new Array(N).fill(null);
  const evPock = new Array(N).fill(null);
  const evBed = new Array(N).fill(null);
  const evClear = new Array(N).fill(null);
  const evFrame = new Array(N).fill(null);
  const evPair = new Array(N * N).fill(null);

  // Rails apply to AIRBORNE balls too (a hop / flight into a cushion must still be caught), but the
  // cushion has a FINITE top (topZ): a ball whose centre is above it clears the rail (Milestone C2).
  const setRail = (i) => {
    evRail[i] = null;
    const b = balls[i];
    if (!isMoving(b, t)) return;
    const w = detectRail(b, rails, t, topZ);
    if (w) evRail[i] = { time: w.time, kind: 'rail', i, rail: w.rail };
  };
  // Rounded pocket jaws (torus rail-ends): sampled non-polynomial contact, also height-capped.
  const setJaw = (i) => {
    evJaw[i] = null;
    const b = balls[i];
    if (!isMoving(b, t) || !jaws.length) return;
    const jw = detectJaw(b, jaws, t, topZ);
    if (jw) evJaw[i] = { time: jw.time, kind: 'jaw', i, jaw: jw.jaw };
  };
  // Pocket capture is 3D-honest: horizontal centre within the mouth AND at/below the lip height —
  // a ball sailing high over the mouth clears it (Milestone C2).
  const setPock = (i) => {
    evPock[i] = null;
    const b = balls[i];
    if (!isMoving(b, t)) return;
    const pk = detectPocket(b, pocketList, t, lipZ);
    if (pk) evPock[i] = { time: pk.time, kind: 'pocket', i, pocketIndex: pk.pocketIndex, rebound: pk.rebound };
  };
  const setBed = (i) => {
    evBed[i] = null;
    const b = balls[i];
    if (!isMoving(b, t) || !airborne(b)) return;
    const bd = detectBed(b, t);
    if (bd) evBed[i] = { time: bd.time, kind: 'bed', i };
  };
  // A ball that flew over the cushion and reaches the table edge above topZ leaves play (cleared).
  const setClear = (i) => {
    evClear[i] = null;
    const b = balls[i];
    if (!isMoving(b, t) || !airborne(b)) return;
    const cl = detectCleared(b, tblBounds, topZ, t);
    if (cl) evClear[i] = { time: cl.time, kind: 'cleared', i };
  };
  // Frame backstop: the physical table edge as a plain wall, catching anything the rail/jaw/pocket
  // miss (a corner-gap parallel runner), excluding pocket mouths so a genuine pot is never blocked.
  const setFrame = (i) => {
    evFrame[i] = null;
    const b = balls[i];
    if (!isMoving(b, t)) return;
    const fr = detectFrame(b, tblBounds, pocketList, topZ, t);
    if (fr) evFrame[i] = { time: fr.time, kind: 'frame', i, axis: fr.axis };
  };
  const setPair = (i, j) => {
    evPair[i * N + j] = null;
    const a = balls[i];
    const b = balls[j];
    if (a.pocketed || b.pocketed) return;
    // Airborne balls DO participate now (Milestone B): a ball can hop onto / hit another mid-air.
    // The pair gap |Δp(t)|²=(2R)² is 3D and stays a quartic — detectPair handles flight segments.
    if (!isMoving(a, t) && !isMoving(b, t)) return;
    const tp = detectPair(a, b, t);
    if (tp < Infinity) evPair[i * N + j] = { time: tp, kind: 'pair', i, j };
  };
  const recompute = (k) => {
    setRail(k);
    setJaw(k);
    setPock(k);
    setBed(k);
    setClear(k);
    setFrame(k);
    for (let m = 0; m < N; m++) {
      if (m === k) continue;
      if (k < m) setPair(k, m);
      else setPair(m, k);
    }
  };
  const clearBody = (i) => {
    evRail[i] = null;
    evJaw[i] = null;
    evPock[i] = null;
    evBed[i] = null;
    evClear[i] = null;
    evFrame[i] = null;
    for (let m = 0; m < N; m++) {
      if (m === i) continue;
      evPair[i < m ? i * N + m : m * N + i] = null;
    }
  };

  for (let i = 0; i < N; i++) {
    setRail(i);
    setJaw(i);
    setPock(i);
    setBed(i);
    setClear(i);
    setFrame(i);
    for (let j = i + 1; j < N; j++) setPair(i, j);
  }

  while (count < cap) {
    const horizon = balls.reduce((m, b) => (isMoving(b, t) ? Math.max(m, stopAbs(b)) : m), t);
    if (horizon <= t) break; // everything at rest or pocketed

    let next = null;
    const consider = (ev) => {
      if (!ev || ev.time <= t) return;
      if (!next || ev.time < next.time - 1e-12) {
        next = ev;
      } else if (ev.time <= next.time + 1e-12) {
        const a = [KIND_RANK[ev.kind], ev.i, ev.j ?? -1];
        const b = [KIND_RANK[next.kind], next.i, next.j ?? -1];
        if (a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])))) next = ev;
      }
    };
    for (let i = 0; i < N; i++) {
      consider(evRail[i]);
      consider(evJaw[i]);
      consider(evPock[i]);
      consider(evBed[i]);
      consider(evClear[i]);
      consider(evFrame[i]);
      for (let j = i + 1; j < N; j++) consider(evPair[i * N + j]);
    }

    if (!next) {
      advance(balls, horizon); // coast to rest
      t = horizon;
      if (wantTimeline) timeline.push(snap(balls, t, 'end'));
      break;
    }

    advance(balls, next.time);
    t = next.time;

    let intensity = 0;
    let hit = null;
    if (next.kind === 'rail') {
      const b = balls[next.i];
      // Cushion-cylinder bounce via the generic 3D resolver. The off-centre (below-centre) axis
      // gives the contact normal an upward tilt, so a firm shot HOPS — emergent, not special-cased.
      intensity = resolveRail(b, next.rail, CUSHION_RESTITUTION, CUSHION_FRICTION_T);
      hit = { id: b.id };
      if (contactBall && b.id === contactBall) cushionHits += 1;
      b.replan();
      b.t0 = t;
      recompute(next.i);
    } else if (next.kind === 'jaw') {
      const b = balls[next.i];
      // Rattle off a rounded jaw torus (sampled contact). The rounded normal deflects the ball back
      // into play or lets it slip through — the rattle-vs-drop outcome is geometric, not scripted.
      intensity = resolveJaw(b, next.jaw, JAW_RESTITUTION, JAW_FRICTION_T);
      hit = { id: b.id };
      if (contactBall && b.id === contactBall) cushionHits += 1;
      b.replan();
      b.t0 = t;
      recompute(next.i);
    } else if (next.kind === 'frame') {
      // Frame backstop: a plain wall reflection at the table edge for a ball the rail/jaw/pocket
      // missed (no hop). Guarantees no escape; in normal play the rail fires first so this is rare.
      const b = balls[next.i];
      intensity = resolveWall(b, next.axis, CUSHION_RESTITUTION, 1e-3, CUSHION_FRICTION_T);
      hit = { id: b.id };
      if (contactBall && b.id === contactBall) cushionHits += 1;
      b.replan();
      b.t0 = t;
      recompute(next.i);
    } else if (next.kind === 'cleared') {
      // The ball flew clean over the cushion and left the playing surface — out of play (not potted).
      const b = balls[next.i];
      b.pocketed = true; // removed from play; flagged `cleared` so callers can distinguish from a pot
      b.cleared = true;
      b.vel = v.vec(0, 0);
      b.spin = { x: 0, y: 0, z: 0 };
      hit = { id: b.id };
      clearBody(next.i);
    } else if (next.kind === 'bed') {
      const b = balls[next.i];
      // Snap exactly onto the bed plane (kills bisection drift so the next flight/slide starts clean).
      b.pos = { x: b.pos.x, y: b.pos.y, z: b.radius };
      if (-b.vel.z <= BED_REST_SPEED) {
        // Too little vertical energy to bounce — settle onto the bed; residual horizontal velocity
        // + spin become a normal slide/roll (anti-Zeno: no infinite micro-bounce chain).
        b.vel = { x: b.vel.x, y: b.vel.y, z: 0 };
      } else {
        // Generic 3D contact against the bed plane (n = +z): the SAME resolver as any contact.
        // Its tangential friction converts landing spin ↔ velocity (a backspun ball checks).
        intensity = resolveContact(b, { x: 0, y: 0, z: 1 }, BED_RESTITUTION, BED_FRICTION_T);
      }
      hit = { id: b.id };
      b.replan();
      b.t0 = t;
      recompute(next.i);
    } else if (next.kind === 'pocket' && next.rebound) {
      // Too fast and off-line to drop — rattle back into play off the pocket. Reflecting the outward
      // velocity keeps it in bounds, so gating capture by speed/line can't reintroduce tunnelling.
      const b = balls[next.i];
      intensity = resolvePocketRebound(b, pocketList[next.pocketIndex].center, POCKET_REBOUND);
      hit = { id: b.id };
      if (contactBall && b.id === contactBall) cushionHits += 1;
      b.replan();
      b.t0 = t;
      recompute(next.i);
    } else if (next.kind === 'pocket') {
      const b = balls[next.i];
      b.pocketed = true;
      b.vel = v.vec(0, 0);
      b.spin = { x: 0, y: 0, z: 0 };
      b.pocket = next.pocketIndex;
      hit = { id: b.id };
      clearBody(next.i);
    } else {
      const a = balls[next.i];
      const b = balls[next.j];
      intensity = resolvePair3D(a, b, BALL_RESTITUTION, BALL_FRICTION_T);
      hit = { a: a.id, b: b.id };
      if (contactBall && (a.id === contactBall || b.id === contactBall)) {
        const other = a.id === contactBall ? b.id : a.id;
        if (firstContact === null) firstContact = other;
        cueContacts.push(other);
      }
      a.replan();
      a.t0 = t;
      b.replan();
      b.t0 = t;
      recompute(next.i);
      recompute(next.j);
    }

    if (wantTimeline) timeline.push(snap(balls, t, next.kind, intensity, hit));
    count += 1;
  }

  return {
    balls,
    timeline,
    // a `cleared` ball (leapt the cushion, off the table) is out of play but NOT a pot — keep the
    // two lists distinct so rules can penalise a leap without scoring it as a pocket.
    pocketed: balls.filter((b) => b.pocketed && !b.cleared).map((b) => b.id),
    cleared: balls.filter((b) => b.cleared).map((b) => b.id),
    firstContact, // id of the first object ball `contactBall` touched, or null
    cueContacts, // ids of every ball `contactBall` touched, in order
    cushionHits, // number of cushions `contactBall` hit
    settled: balls.every((b) => b.pocketed || !isMoving(b, t)),
    events: count,
    hitCap: count >= MAX_EVENTS,
  };
}
