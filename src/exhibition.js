// exhibition.js — generate a scripted, engine-VALIDATED 147 maximum break for the "Record a 147"
// video, played as a real frame of snooker: the standard opening rack (15 reds in the triangle
// behind the pink, six colours on their spots, cue in the D), a genuine break shot that clips the
// pack and scatters the reds, then a continuous clearance — 15×(red, black) then the six colours in
// order — with the cue flowing shot to shot under follow/draw/side position play.
//
// Every shot is simulated and only accepted if it pots exactly the intended ball (no in-off, no
// collateral). Shot selection uses a depth-2 lookahead so each pot leaves the cue on the NEXT ball;
// when clean position runs out the ball is still potted LEGALLY from where the cue lies (a thin cut
// or a shot off a cushion, found by a fine aim sweep) rather than by moving the cue. Only if a ball
// is genuinely unreachable is the cue replaced (ball-in-hand) as a last resort — rare, usually zero.
//
// build147() is async: it yields between candidate breaks so the caller can paint a progress status,
// and stops early on the first break that needs no cue replacement. Snooker only.
import * as v3 from './vec3.js';
import { Ball } from './motion.js';
import { simulate } from './simulate.js';
import { bounds, pockets, HX, HY, spots, baulkX } from './table.js';
import { BALL } from './snooker.js';
import { openingPieces } from './rack.js';

const R = BALL.radius;
const PKS = pockets().map((p) => p.center);
const COLOURS = ['yellow', 'green', 'brown', 'blue', 'pink', 'black'];
// the 147 order: 15 reds each followed by the black, then the six colours cleared in ascending value
const SEQ = [];
for (let i = 0; i < 15; i++) SEQ.push('red', 'black');
SEQ.push(...COLOURS);

const groupOf = (c) => (c === 'cue' ? 'cue' : c === 'red' ? 'red' : 'colour');
const mkB = (id, color, pos) => new Ball({ id, kind: groupOf(color), color, radius: R, mass: BALL.mass, pos: v3.vec(pos.x, pos.y, R), spin: v3.vec(0, 0, 0) });
const inTable = (p, m = 0.04) => Math.abs(p.x) < HX - R - m && Math.abs(p.y) < HY - R - m;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const yieldToUI = () => new Promise((r) => setTimeout(r, 0));

// One cue strike into a layout; the cue starts at `C`. Returns the raw simulate result.
const shoot = (balls, C, aim, speed, spin = { side: 0, vert: 0 }) =>
  simulate({ balls: balls.map((b) => mkB(b.id, b.color, b.id === 'cue' ? C : b.pos)), bounds: bounds(), pockets: pockets() }, { ballId: 'cue', angle: aim, speed, spin }, { contactBall: 'cue' });
const restMap = (res) => new Map(res.balls.map((b) => [b.id, { x: b.pos.x, y: b.pos.y }]));
const cueRestOf = (res) => { const c = res.balls.find((b) => b.id === 'cue').pos; return { x: c.x, y: c.y }; };
const onTable = (p) => Math.abs(p.x) < HX - R && Math.abs(p.y) < HY - R;

// Is the segment A→B clear of every ball centre (ignoring `skip` ids) by `clr`?
function segClear(A, B, balls, skip, clr) {
  for (const b of balls) {
    if (skip.includes(b.id)) continue;
    const dx = B.x - A.x;
    const dy = B.y - A.y;
    const L2 = dx * dx + dy * dy;
    let t = L2 > 0 ? ((b.pos.x - A.x) * dx + (b.pos.y - A.y) * dy) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    if (Math.hypot(b.pos.x - (A.x + t * dx), b.pos.y - (A.y + t * dy)) < clr) return false;
  }
  return true;
}
// colour of the first object ball the cue strikes (from the timeline's first cue pair event)
function firstHit(res, colorById) {
  for (const e of res.timeline) {
    if (e.kind === 'pair' && e.hit && (e.hit.a === 'cue' || e.hit.b === 'cue')) {
      return colorById[e.hit.a === 'cue' ? e.hit.b : e.hit.a];
    }
  }
  return null;
}

// A shot descriptor the renderer can play: the pre-shot cue position is implicit in `pieces`.
const shotFrom = (res) => ({ rest: restMap(res), timeline: res.timeline, cueRest: cueRestOf(res) });

// speed / vertical (follow+ / draw−) / side spin combos, ordered cheap→expensive for position play
const STYLES = [[2.4, 0, 0], [3.0, 0.6, 0], [3.4, -0.5, 0], [4.0, 0.7, 0], [3.0, 0, 0.4], [3.0, 0, -0.4], [4.5, 0.8, 0]];

// Clean pots of `targetId` into a pocket via the ghost-ball line. `full` tries every style (for
// ranking / execution); otherwise the first working style per pocket (fast, for the lookahead).
function cutShots(balls, C, targetId, full) {
  const B = balls.find((b) => b.id === targetId);
  if (!B) return [];
  const out = [];
  for (const P of PKS) {
    const bp = Math.hypot(P.x - B.pos.x, P.y - B.pos.y);
    if (bp < 0.2) continue;
    if (!segClear(B.pos, P, balls, [targetId], R + 0.004)) continue; // ball → pocket clear
    const uPB = { x: (P.x - B.pos.x) / bp, y: (P.y - B.pos.y) / bp };
    const G = { x: B.pos.x - 2 * R * uPB.x, y: B.pos.y - 2 * R * uPB.y }; // ghost-ball centre at contact
    const cg = Math.hypot(G.x - C.x, G.y - C.y);
    if (cg < 0.05) continue;
    const uCG = { x: (G.x - C.x) / cg, y: (G.y - C.y) / cg };
    if (uCG.x * uPB.x + uCG.y * uPB.y < 0.3) continue; // too thin a cut to trust as a position shot
    if (!segClear(C, G, balls, ['cue', targetId], 1.85 * R)) continue; // cue path to ghost clear
    const aim = Math.atan2(uCG.y, uCG.x);
    for (const [speed, vert, side] of full ? STYLES : STYLES.slice(0, 3)) {
      const res = shoot(balls, C, aim, speed, { side, vert });
      if (res.pocketed.length === 1 && res.pocketed[0] === targetId) {
        out.push(shotFrom(res));
        if (!full) break;
      }
    }
  }
  return out;
}

// A LEGAL pot of `targetId` from the cue's ACTUAL position by any means — a fine aim sweep that will
// find thin cuts and cushion-first shots the ghost-ball search rejects. Keeps the cue on the table
// (no ball-in-hand) when clean position has been lost. Picks the outcome leaving the cue most central.
function hardPot(balls, C, targetId) {
  const B = balls.find((b) => b.id === targetId);
  if (!B) return null;
  const base = Math.atan2(B.pos.y - C.y, B.pos.x - C.x);
  let best = null;
  for (let da = -1.2; da <= 1.2; da += 0.03) {
    for (const speed of [2.8, 3.6, 4.5, 5.5]) {
      const res = shoot(balls, C, base + da, speed);
      if (res.pocketed.length === 1 && res.pocketed[0] === targetId) {
        const cr = cueRestOf(res);
        const score = 1 - Math.min(1, Math.hypot(cr.x, cr.y) / HX);
        if (!best || score > best.score) best = { ...shotFrom(res), score };
      }
    }
  }
  return best;
}

// Last resort: replace the cue (ball-in-hand) behind the target for a clean pot — used only when the
// ball cannot be potted from where the cue lies. Fans approach angles so rail-hugging balls still go.
function repositionPot(balls, targetId) {
  const B = balls.find((b) => b.id === targetId);
  if (!B) return null;
  for (const P of PKS) {
    const bp = Math.hypot(P.x - B.pos.x, P.y - B.pos.y);
    if (bp < 0.25) continue;
    if (!segClear(B.pos, P, balls, [targetId], R + 0.006)) continue;
    const uPB = { x: (P.x - B.pos.x) / bp, y: (P.y - B.pos.y) / bp };
    const G = { x: B.pos.x - 2 * R * uPB.x, y: B.pos.y - 2 * R * uPB.y };
    const base = Math.atan2(-uPB.y, -uPB.x);
    for (const off of [0, 0.2, -0.2, 0.4, -0.4, 0.6, -0.6]) {
      for (const d of [0.4, 0.6]) {
        const cue = { x: G.x + Math.cos(base + off) * d, y: G.y + Math.sin(base + off) * d };
        if (!inTable(cue, 0.04)) continue;
        if (balls.some((b) => b.id !== 'cue' && b.id !== targetId && dist(cue, b.pos) < 2.1 * R)) continue;
        if (!segClear(cue, G, balls, ['cue', targetId], 1.85 * R)) continue;
        const aim = Math.atan2(G.y - cue.y, G.x - cue.x);
        for (const speed of [2.6, 3.3]) {
          const res = shoot(balls, cue, aim, speed);
          if (res.pocketed.length === 1 && res.pocketed[0] === targetId) return { ...shotFrom(res), cuePos: cue };
        }
      }
    }
  }
  return null;
}

// Remove the potted ball; re-spot the colour during the red phase (a black potted with reds still on
// comes back on its spot). `i` is the sequence index; colours in the final clearance (i>=30) stay down.
function applyShot(balls, tid, color, i, rest, sp) {
  const next = balls.filter((b) => b.id !== tid).map((b) => ({ ...b, pos: rest.get(b.id) || b.pos }));
  if (color !== 'red' && i < 30) next.push({ id: color, color, pos: { ...sp[color] } });
  return next;
}

// Can the break stay alive for `depth` more pots from (balls, C) at sequence index i? Tries the three
// cue-rest-nearest shots per level — enough to tell "the cue is on the next ball(s)" from "it's dead".
function chain(balls, C, i, depth, sp) {
  if (depth <= 0 || i >= SEQ.length) return true;
  const color = SEQ[i];
  const cands = color === 'red' ? balls.filter((b) => b.color === 'red').map((b) => b.id) : [color];
  const shots = [];
  for (const tid of cands) for (const s of cutShots(balls, C, tid, false)) shots.push({ tid, s });
  if (!shots.length) return false;
  shots.sort((a, b) => Math.hypot(a.s.cueRest.x, a.s.cueRest.y) - Math.hypot(b.s.cueRest.x, b.s.cueRest.y));
  for (const { tid, s } of shots.slice(0, 3)) {
    if (chain(applyShot(balls, tid, color, i, s.rest, sp), s.cueRest, i + 1, depth - 1, sp)) return true;
  }
  return false;
}

// Play the whole clearance from a broken layout. Returns the per-pot steps plus counts of how each
// pot was made: `flow` (clean position), `hard` (legal but tough, cue not moved), `repos` (cue
// replaced — the only non-snooker case). `ok` is false if a ball was completely unpottable.
function clear147(startBalls, startC, sp) {
  let balls = startBalls.map((b) => ({ ...b, pos: { ...b.pos } }));
  let C = { ...startC };
  const steps = [];
  let flow = 0;
  let hard = 0;
  let repos = 0;
  for (let i = 0; i < SEQ.length; i++) {
    const color = SEQ[i];
    const cands = color === 'red' ? balls.filter((b) => b.color === 'red').map((b) => b.id) : [color];
    // rank every clean pot by depth-2 lookahead (leaves the cue on the ball after next), then breadth
    let best = null;
    for (const tid of cands) {
      for (const s of cutShots(balls, C, tid, true)) {
        const after = applyShot(balls, tid, color, i, s.rest, sp);
        const d2 = chain(after, s.cueRest, i + 1, 2, sp) ? 1 : 0;
        const d1 = chain(after, s.cueRest, i + 1, 1, sp) ? 1 : 0;
        const central = 1 - Math.min(1, Math.hypot(s.cueRest.x, s.cueRest.y) / HX);
        const score = d2 * 100 + d1 * 10 + central;
        if (!best || score > best.score) best = { tid, s, score, d1 };
      }
    }
    let chosen = null;
    let usedId = null;
    let mode = 'flow';
    if (best && best.d1) { chosen = best.s; usedId = best.tid; }
    else {
      for (const tid of cands) { const h = hardPot(balls, C, tid); if (h) { chosen = h; usedId = tid; mode = 'hard'; break; } }
      if (!chosen) for (const tid of cands) { const r = repositionPot(balls, tid); if (r) { chosen = r; usedId = tid; mode = 'repos'; break; } }
      if (!chosen && best) { chosen = best.s; usedId = best.tid; } // pot it even if position is poor
    }
    if (!chosen) return { steps, flow, hard, repos, ok: false };
    if (mode === 'flow') flow++; else if (mode === 'hard') hard++; else repos++;
    // the cue's pre-shot position for this step: its current rest, unless we replaced it
    const cueStart = mode === 'repos' ? chosen.cuePos : C;
    const pieces = balls.map((b) => ({ id: b.id, color: b.color, group: groupOf(b.color), kind: groupOf(b.color), pos: b.id === 'cue' ? { ...cueStart } : { ...b.pos } }));
    steps.push({ pieces, timeline: chosen.timeline });
    balls = applyShot(balls, usedId, color, i, chosen.rest, sp);
    C = { ...chosen.cueRest };
  }
  return { steps, flow, hard, repos, ok: true };
}

// Candidate break shots: cue in the D off the spine, driven into an outer red so the pack opens.
// Keep only breaks that clip a RED first, pot nothing, leave the cue on the table AND leave a clean
// first red to pot. Sorted by how open the pack ends up (mean nearest-neighbour gap).
function planBreaks(balls, colorById) {
  const reds = balls.filter((b) => b.color === 'red');
  const list = [];
  for (const cy of [-0.30, -0.26, -0.22, -0.18, 0.18, 0.22, 0.26, 0.30]) {
    const cue = { x: baulkX() + R * 0.5, y: cy };
    for (const tr of reds) {
      const aim = Math.atan2(tr.pos.y - cue.y, tr.pos.x - cue.x);
      for (const speed of [9, 8.2]) {
        const res = shoot(balls, cue, aim, speed);
        if (firstHit(res, colorById) !== 'red' || res.pocketed.length !== 0) continue;
        const cr = cueRestOf(res);
        if (!onTable(cr)) continue;
        const rest = restMap(res);
        const after = balls.map((b) => ({ ...b, pos: rest.get(b.id) || b.pos }));
        if (!after.filter((b) => b.color === 'red').some((rd) => cutShots(after, cr, rd.id, false).length)) continue;
        const rp = reds.map((r) => rest.get(r.id));
        let sep = 0;
        for (const a of rp) { let mn = Infinity; for (const b of rp) if (a !== b) mn = Math.min(mn, dist(a, b)); sep += mn; }
        list.push({ cue, timeline: res.timeline, rest, cueRest: cr, spread: sep / rp.length });
      }
    }
  }
  list.sort((a, b) => b.spread - a.spread);
  return list;
}

// The full 147 as an array of steps { pieces, timeline }: step 0 is the break (from the standard
// rack), then the 36 pots. Async so the caller can paint progress; `onProgress(done,total)` is
// optional. Returns [] if no break yielded a complete clearance.
export async function build147(onProgress) {
  const base = openingPieces().map((p) => ({ id: p.id, color: p.color, pos: { ...p.pos } }));
  const colorById = Object.fromEntries(base.map((b) => [b.id, b.color]));
  const sp = spots();
  const breaks = planBreaks(base, colorById);
  let best = null;
  const tries = Math.min(breaks.length, 5);
  for (let n = 0; n < tries; n++) {
    if (onProgress) onProgress(n, tries);
    await yieldToUI();
    const br = breaks[n];
    const broken = base.map((b) => ({ ...b, pos: br.rest.get(b.id) || b.pos }));
    const r = clear147(broken, br.cueRest, sp);
    if (r.ok && (!best || r.repos < best.r.repos || (r.repos === best.r.repos && r.hard < best.r.hard))) {
      best = { br, r };
      if (r.repos === 0) break; // a fully legal maximum — good enough, stop searching
    }
  }
  if (!best) return [];
  // step 0: the break, played from the standard rack
  const rackPieces = base.map((b) => ({ id: b.id, color: b.color, group: groupOf(b.color), kind: groupOf(b.color), pos: { ...b.pos } }));
  return [{ pieces: rackPieces, timeline: best.br.timeline }, ...best.r.steps];
}
