// ai.js — the computer opponent, variant-driven.
//
// candidateShots — ghost-ball aims (strike the target one ball-diameter back along the line
//   from the pocket), generated from the variant's legal targets and pockets, ranked by
//   geometry. When ball-in-hand, the variant supplies candidate cue placements.
// chooseShot — simulation-scored selection: run the real engine to rest over a small
//   power × angle × spin grid around each top candidate and keep the best-scoring outcome
//   (legal first contact, pot the ball-on, no scratch). Optional robustness pass averages the
//   score over an execution-error box so the AI plays to its own reliability.

import * as v from './vec2.js';
import { simulate } from './simulate.js';
import { buildBalls } from './game.js';
import { MAX_SPEED, MU_ROLL, GRAVITY } from './snooker.js';

const A_ROLL = MU_ROLL * GRAVITY;

function candidatesFrom(state, cuePos) {
  const variant = state.variant;
  const R = variant.ball.radius;
  const out = [];
  for (const T of variant.aiTargets(state)) {
    for (const pk of variant.pockets()) {
      const toP = v.sub(pk.center, T.pos);
      const dP = v.len(toP);
      if (dP < 1e-6) continue;
      const dir = v.scale(toP, 1 / dP);
      const ghost = v.sub(T.pos, v.scale(dir, 2 * R));
      const sc = v.sub(ghost, cuePos);
      const scLen = v.len(sc);
      if (scLen < 1e-6) continue;
      const align = v.dot(v.scale(sc, 1 / scLen), dir);
      if (align <= 0.25) continue;
      const pathLen = scLen + dP;
      const speed = Math.max(1.0, Math.min(MAX_SPEED, Math.sqrt(2 * A_ROLL * pathLen) * 1.6 + 0.6));
      out.push({ cuePos: { ...cuePos }, angle: Math.atan2(sc.y, sc.x), speed, geom: align - 0.15 * pathLen });
    }
  }
  return out;
}

function candidateShots(state) {
  const variant = state.variant;
  // pocketless games (carom) can't use ghost-ball-into-a-pocket aiming — they supply their own
  if (variant.aiCandidates) return variant.aiCandidates(state).sort((a, b) => b.geom - a.geom);
  const cue = state.pieces.find((p) => p.id === 'cue');
  let out = [];
  if (state.frame.ballInHand || !cue) {
    for (const cp of variant.aiPlacements(state)) out = out.concat(candidatesFrom(state, cp));
  } else {
    out = candidatesFrom(state, cue.pos);
  }
  out.sort((a, b) => b.geom - a.geom);
  return out;
}

// --- positional play (Tier 2: feasibility-aware leave) ---
// A secondary term that rewards leaving the cue ball where the NEXT shot is actually MAKEABLE. It
// is a single-ply look-ahead that REUSES what we already computed: the shot is simulated to rest,
// so the cue ball's resting position and the surviving layout are in `res`. We learn the next
// ball-on (and whether we keep the table) by replaying the variant's OWN rules on a throwaway copy
// of the frame, then score the best next pot from the cue's rest spot — not by raw geometry, but
// by a pot-PROBABILITY proxy that accounts for cut angle, shot length, and OBSTRUCTION of both the
// cue→ghost and ball→pocket lines. Weighted below a pot, so it only biases the leave.
const POSITION_WEIGHT = 36;
// Safety play: when a shot pots nothing but legally passes the turn, reward leaving the OPPONENT
// without a makeable pot (a snooker / awkward leave). Kept below a single ball's value (100) so a
// real pot is always preferred — the AI only plays safe when it genuinely cannot score.
//   SAFETY_TRIGGER — only a safety that leaves the opponent's best pot BELOW this prob pays off;
//     a weak "safety" that still leaves them a chance earns nothing, so the AI attacks instead of
//     nestling defensively. Raise it for a more defensive AI, lower it for a more aggressive one.
const SAFETY_WEIGHT = 30;
const SAFETY_TRIGGER = 0.22;
// A genuine SNOOKER — the opponent has NO direct line to any ball-on, so they must escape off a cushion
// or foul (conceding 4+) — is worth more than a merely awkward-but-hittable leave. Added ON TOP of the
// safety term when the leave snookers, so the AI actively HUNTS snookers, not just no-pot leaves. Kept
// below a ball's value (100) so a real pot is always preferred; only bites when nothing is on to score.
const SNOOKER_WEIGHT = 48;
// 2-ply look-ahead: reward a red-pot whose leave on the black ALSO recovers a red after the black
// is potted — i.e. it keeps the red→black→red cycle (a 147) alive. Weighted below the single-ply
// leave so it only refines among already-good lines.
const LOOKAHEAD2_WEIGHT = 22;
const LEAVE_EFOLD = 1.6; // metres: shot-length e-folding in the pot-probability proxy
// Forgiveness: when re-ranking to reliability, probe AT LEAST this aim/power margin (even a steady
// hand should prefer a shot with room for error, not a knife-edge line), and weight the WORST perturbed
// outcome this much against the mean — so a shot that's brilliant nominally but disastrous when nudged
// loses to a solid one that holds up. Higher FORGIVE_WORST_W = more cautious/percentage play.
const FORGIVE_ANGLE = 0.006; // rad (~0.34°)
const FORGIVE_SPEED = 0.03; // fractional power
const FORGIVE_WORST_W = 0.5;

// Distance from point C to segment A→B (both endpoints inclusive).
function segPointDist(ax, ay, bx, by, cx, cy) {
  const dx = bx - ax;
  const dy = by - ay;
  const L2 = dx * dx + dy * dy;
  let t = L2 > 0 ? ((cx - ax) * dx + (cy - ay) * dy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  const px = ax + t * dx;
  const py = ay + t * dy;
  return Math.hypot(cx - px, cy - py);
}

// Is the straight corridor from A to B clear of every blocker centre (ignoring up to two ids)?
// Takes the skip ids directly rather than a Set — this runs per target×pocket in a hot loop, and
// allocating a 2-element Set each time was pure churn.
function pathClear(A, B, blockers, clearance, skip1, skip2) {
  for (const b of blockers) {
    if (b.id === skip1 || b.id === skip2) continue;
    if (segPointDist(A.x, A.y, B.x, B.y, b.pos.x, b.pos.y) < clearance) return false;
  }
  return true;
}

// Is the player to strike from `cuePos` SNOOKERED — no direct straight line to ANY ball-on (every path
// is blocked by a ball that isn't on)? A snooker forces an escape off a cushion or a foul, so laying
// one is the prize of defensive play. Uses the same 2R corridor test as the pot proxy, skipping the
// cue and the target itself as "blockers". `state` carries the ball-on set via variant.aiTargets — so
// pass the ADVANCED (post-shot, turn-flipped) state to ask "is the OPPONENT snookered?".
export function opponentSnookered(state, cuePos) {
  const variant = state.variant;
  const targets = variant.aiTargets(state);
  if (!targets.length) return false;
  const clearance = 2 * variant.ball.radius - 1e-3;
  for (const T of targets) {
    if (pathClear(cuePos, T.pos, state.pieces, clearance, 'cue', T.id)) return false; // a clean contact exists
  }
  return true; // no ball-on can be struck directly
}

// Best makeable next pot from `cuePos`, as a [0,1] pot-probability proxy. Considers every legal
// next target into every pocket: rejects thin cuts and blocked lines, then scores by cut angle
// (cos²) × shot-length decay, WEIGHTED by the value of the ball it would leave on. 0 = snookered.
//
// The value weight (`(value/maxValue)²`) is what makes the AI play for the BLACK off every red:
// when the next ball-on is "any-colour" it prefers a leave on the 7 over an equally-easy leave on
// a lower colour — the core requirement of a 147. It is deliberately a no-op outside that phase:
// on reds every target is value 1, and when clearing only one colour is on, so the weight is a
// flat 1 and the term reduces to pure pot-ease. Normalised by the max target value so the result
// stays ~[0,1] and POSITION_WEIGHT keeps its calibration.
//
// SNOOKER-ONLY: gated on the variant's explicit `playForValue` flag, not on whether `aiValue`
// happens to vary — so giving another variant per-ball values can never silently turn this on.
function bestNextPotProb(state, cuePos, adv = false) {
  const variant = state.variant;
  const R = variant.ball.radius;
  const targets = variant.aiTargets(state);
  const pockets = variant.pockets();
  const blockers = state.pieces;
  const clearance = 2 * R - 1e-3;
  const byValue = adv && variant.playForValue === true; // deadly + snooker: play for the black off every red
  const valOf = (T) => (variant.aiValue ? variant.aiValue(state.frame, T) : 1);
  const maxVal = byValue ? Math.max(1, ...targets.map(valOf)) : 1;
  let best = 0;
  for (const T of targets) {
    const w = byValue ? (valOf(T) / maxVal) ** 2 : 1; // play for the high-value ball (black after a red)
    for (const pk of pockets) {
      const toP = v.sub(pk.center, T.pos);
      const dTP = v.len(toP);
      if (dTP < 1e-6) continue;
      const dir = v.scale(toP, 1 / dTP);
      const ghost = v.sub(T.pos, v.scale(dir, 2 * R));
      const sc = v.sub(ghost, cuePos);
      const dCG = v.len(sc);
      if (dCG < 1e-6) continue;
      const cosCut = v.dot(v.scale(sc, 1 / dCG), dir);
      if (cosCut <= 0.2) continue; // beyond ~78° cut: treat as unmakeable
      if (!pathClear(cuePos, ghost, blockers, clearance, 'cue', T.id)) continue; // ignore cue + target
      if (!pathClear(T.pos, pk.center, blockers, clearance, T.id)) continue; // ignore the target
      const p = w * cosCut * cosCut * Math.exp(-(dCG + dTP) / LEAVE_EFOLD);
      if (p > best) best = p;
    }
  }
  return best;
}

function positionBonus(state, res, pieceById, adv = false) {
  const variant = state.variant;
  if (!variant.applyOutcome || !variant.aiTargets) return 0;

  // build the rules info the variant expects (pieces, not ids)
  const potted = [];
  let cuePotted = false;
  for (const id of res.pocketed) {
    if (id === 'cue') { cuePotted = true; continue; }
    const p = pieceById.get(id);
    if (p) potted.push(p);
  }
  const firstContact = res.firstContact ? pieceById.get(res.firstContact) : null;
  const cueContacts = (res.cueContacts || []).map((id) => pieceById.get(id)).filter(Boolean);

  // ask the variant's real rules what happens next, on a disposable frame copy
  const nf = structuredClone(state.frame);
  let next;
  try {
    next = variant.applyOutcome(nf, { firstContact, potted, cuePotted, cueContacts, cushionHits: res.cushionHits || 0 });
  } catch {
    return 0;
  }
  if (!next || next.foul) return 0; // a foul is scored by the main foul penalty, not here

  // cue's resting position; if it's gone (scratch) there's no position to value
  const cueBall = res.balls.find((b) => b.id === 'cue');
  if (!cueBall || cueBall.pocketed) return 0;

  // the surviving table after the shot, paired with the advanced (cloned) frame
  const survivors = res.balls
    .filter((b) => !b.pocketed)
    .map((b) => { const p = pieceById.get(b.id); return p ? { ...p, pos: { x: b.pos.x, y: b.pos.y } } : null; })
    .filter(Boolean);
  const nextState = { variant, frame: nf, pieces: survivors };
  const prob = bestNextPotProb(nextState, { x: cueBall.pos.x, y: cueBall.pos.y }, adv);

  if (next.continues) {
    // our own leave — reward a makeable next pot for us
    if (prob <= 0) return -0.35 * POSITION_WEIGHT; // continued, but snookered / nothing makeable
    return POSITION_WEIGHT * prob;
  }

  // A legal MISS: the turn passes, so `prob` here is the OPPONENT's best next pot from the layout we
  // leave. SAFETY PLAY, two tiers: a low-pot leave (best pot below SAFETY_TRIGGER) earns the graded
  // safety term; a genuine SNOOKER (no direct line to any ball-on → forced escape/foul) earns
  // SNOOKER_WEIGHT on top, so the AI hunts snookers rather than nestling for a merely awkward leave.
  // Deadly + snooker only; other variants keep the roll-to-target fallback.
  if (!adv || !variant.safetyPlay) return 0;
  const oppProb = Math.min(1, prob);
  let bonus = 0;
  if (oppProb < SAFETY_TRIGGER) bonus += SAFETY_WEIGHT * (1 - oppProb / SAFETY_TRIGGER);
  if (opponentSnookered(nextState, { x: cueBall.pos.x, y: cueBall.pos.y })) bonus += SNOOKER_WEIGHT;
  return bonus;
}

function scoreOutcome(state, res, pieceById, adv = false) {
  const variant = state.variant;
  const frame = state.frame;
  if (variant.aiScore) return variant.aiScore(state, res, pieceById); // carom & other non-pot games
  let score = 0;
  let cuePotted = false;
  const potted = [];
  for (const id of res.pocketed) {
    if (id === 'cue') cuePotted = true;
    else potted.push(pieceById.get(id));
  }
  const fc = res.firstContact ? pieceById.get(res.firstContact) : null;
  if (!variant.aiLegalFirst(frame, fc)) score -= 300;
  if (cuePotted) score -= 400;
  for (const p of potted) {
    if (variant.aiLegalPot(frame, p)) score += variant.aiValue(frame, p) + (variant.aiWinBonus ? variant.aiWinBonus(frame, p) : 0);
    else score -= variant.aiPenalty ? variant.aiPenalty(frame, p) : variant.aiValue(frame, p);
  }
  // Variant-specific multi-pot adjustment (snooker: damp potting >1 red in a stroke — it forfeits
  // a black and shortens the break). Deadly-only; optional hook, variants without it are unaffected.
  if (adv && variant.aiPottedAdjust) score += variant.aiPottedAdjust(frame, potted);
  score += positionBonus(state, res, pieceById, adv);
  return score;
}

// Build the pieces array (cue placed at cuePos) and its id→piece map for a shot. simulate() never
// mutates either — it works on the buildBalls() copy — so these are IDENTICAL across a candidate's
// whole power×angle×spin grid and can be built once per candidate (see chooseShot).
function cuePieces(state, cuePos) {
  const variant = state.variant;
  const pieces = state.pieces.map((p) => (p.id === 'cue' ? { ...p, pos: { ...cuePos } } : p));
  if (!pieces.some((p) => p.id === 'cue')) pieces.push({ id: 'cue', color: variant.cueColor, group: 'cue', kind: 'cue', pos: { ...cuePos } });
  return { pieces, pieceById: new Map(pieces.map((p) => [p.id, p])) };
}

// Score one shot from a pre-built pieces/pieceById (only the fresh balls per sim are unavoidable).
function simScoreP(state, pieces, pieceById, angle, speed, spin, adv) {
  const variant = state.variant;
  const balls = buildBalls(pieces, variant.ball);
  const res = simulate({ balls, bounds: variant.bounds(), pockets: variant.pockets() }, { ballId: 'cue', angle, speed, spin }, { timeline: false, contactBall: 'cue' });
  return scoreOutcome(state, res, pieceById, adv);
}

function simScore(state, cuePos, angle, speed, spin, adv = false) {
  const { pieces, pieceById } = cuePieces(state, cuePos);
  return simScoreP(state, pieces, pieceById, angle, speed, spin, adv);
}

// Simulate one opening-break candidate and report what matters for picking a break by STYLE:
// whether it's legal (first contact a red, no in-off), how safe the leave is (scoreOutcome, which
// includes the safety term), and how much it SPREADS the pack (total red displacement; a potted
// red counts as a big change). Reuses the same engine call as simScore.
function evalBreak(state, { cuePos, angle, speed, spin }) {
  const variant = state.variant;
  const pieces = state.pieces.map((p) => (p.id === 'cue' ? { ...p, pos: { ...cuePos } } : p));
  if (!pieces.some((p) => p.id === 'cue')) pieces.push({ id: 'cue', color: variant.cueColor, group: 'cue', kind: 'cue', pos: { ...cuePos } }); // break with ball-in-hand: cue not yet on the table
  const balls = buildBalls(pieces, variant.ball);
  const pieceById = new Map(pieces.map((p) => [p.id, p]));
  const res = simulate({ balls, bounds: variant.bounds(), pockets: variant.pockets() }, { ballId: 'cue', angle, speed, spin }, { timeline: false, contactBall: 'cue' });
  const fc = res.firstContact ? pieceById.get(res.firstContact) : null;
  const cueBall = res.balls.find((b) => b.id === 'cue');
  const legal = !!fc && fc.color === 'red' && !res.pocketed.includes('cue') && !!cueBall && !cueBall.pocketed;
  const after = new Map(res.balls.map((b) => [b.id, b]));
  let spread = 0;
  for (const p of pieces) {
    if (p.color !== 'red') continue;
    const a = after.get(p.id);
    spread += !a || a.pocketed ? 0.25 : Math.hypot(a.pos.x - p.pos.x, a.pos.y - p.pos.y);
  }
  return { legal, spread, cueX: cueBall ? cueBall.pos.x : 0, safety: scoreOutcome(state, res, pieceById, true) };
}

// 2-ply look-ahead (deadly + snooker): given a candidate that pots a red and gets on a colour,
// estimate whether potting the BLACK from the resulting position recovers a red — keeping the
// red→black→red maximum cycle alive. Bounded: only the black's single best pocket × a small
// power×draw grid. Returns a bonus to add to the ply-1 score (0 unless it's a clean red-pot that
// continues onto a colour). Reuses the same engine + bestNextPotProb proxy as the rest of the AI.
function cycleBonus(state, shot) {
  const variant = state.variant;
  const R = variant.ball.radius;
  // ply 1 — simulate the actual candidate shot to rest (add the cue if the frame owes ball-in-hand)
  const pieces1 = state.pieces.map((p) => (p.id === 'cue' ? { ...p, pos: { ...shot.cuePos } } : p));
  if (!pieces1.some((p) => p.id === 'cue')) pieces1.push({ id: 'cue', color: variant.cueColor, group: 'cue', kind: 'cue', pos: { ...shot.cuePos } });
  const byId1 = new Map(pieces1.map((p) => [p.id, p]));
  const res1 = simulate({ balls: buildBalls(pieces1, variant.ball), bounds: variant.bounds(), pockets: variant.pockets() }, { ballId: 'cue', angle: shot.angle, speed: shot.speed, spin: shot.spin }, { timeline: false, contactBall: 'cue' });
  if (res1.pocketed.includes('cue')) return 0;
  const fc1 = res1.firstContact ? byId1.get(res1.firstContact) : null;
  const potted1 = res1.pocketed.filter((id) => id !== 'cue').map((id) => byId1.get(id)).filter(Boolean);
  if (!fc1 || fc1.color !== 'red' || !potted1.length || potted1.some((p) => p.color !== 'red')) return 0;
  const nf1 = structuredClone(state.frame);
  const next1 = variant.applyOutcome(nf1, { firstContact: fc1, potted: potted1, cuePotted: false, cueContacts: [], cushionHits: res1.cushionHits || 0 });
  if (!next1 || next1.foul || !next1.continues) return 0;
  const cue1 = res1.balls.find((b) => b.id === 'cue');
  if (!cue1 || cue1.pocketed) return 0;
  const surv1 = res1.balls.filter((b) => !b.pocketed).map((b) => { const p = byId1.get(b.id); return p ? { ...p, pos: { x: b.pos.x, y: b.pos.y } } : null; }).filter(Boolean);
  const black = surv1.find((p) => p.color === 'black');
  if (!black) return 0;
  const cuePos1 = { x: cue1.pos.x, y: cue1.pos.y };
  // pick the black's best pocket by clear ghost-ball geometry (cut angle / length)
  let aimBlack = null;
  let bestQual = 0;
  for (const pk of variant.pockets()) {
    const toP = v.sub(pk.center, black.pos);
    const dTP = v.len(toP);
    if (dTP < 1e-6) continue;
    const dir = v.scale(toP, 1 / dTP);
    const ghost = v.sub(black.pos, v.scale(dir, 2 * R));
    const sc = v.sub(ghost, cuePos1);
    const dCG = v.len(sc);
    if (dCG < 1e-6) continue;
    const cos = v.dot(v.scale(sc, 1 / dCG), dir);
    if (cos <= 0.25) continue;
    const qual = cos / (1 + dCG + dTP);
    if (qual > bestQual) { bestQual = qual; aimBlack = { angle: Math.atan2(sc.y, sc.x), pathLen: dCG + dTP }; }
  }
  if (!aimBlack) return 0;
  // ply 2 — try a few black pots; reward the best red-makeability that survives a clean black pot
  let bestRed = 0;
  const base = Math.max(1.0, Math.min(MAX_SPEED, Math.sqrt(2 * A_ROLL * aimBlack.pathLen) * 1.6 + 0.6));
  for (const ps of [0.95, 1.15, 1.4]) {
    const speed = Math.max(1.0, Math.min(MAX_SPEED, base * ps));
    for (const vert of [0, 0.6, -0.6]) {
      const pieces2 = surv1.map((p) => (p.id === 'cue' ? { ...p, pos: { ...cuePos1 } } : p));
      const byId2 = new Map(pieces2.map((p) => [p.id, p]));
      const res2 = simulate({ balls: buildBalls(pieces2, variant.ball), bounds: variant.bounds(), pockets: variant.pockets() }, { ballId: 'cue', angle: aimBlack.angle, speed, spin: { side: 0, vert } }, { timeline: false, contactBall: 'cue' });
      if (res2.pocketed.includes('cue')) continue;
      const potted2 = res2.pocketed.filter((id) => id !== 'cue').map((id) => byId2.get(id)).filter(Boolean);
      if (!potted2.some((p) => p.color === 'black') || potted2.some((p) => p.color !== 'black')) continue;
      const cue2 = res2.balls.find((b) => b.id === 'cue');
      if (!cue2 || cue2.pocketed) continue;
      const fc2 = res2.firstContact ? byId2.get(res2.firstContact) : null;
      const surv2 = res2.balls.filter((b) => !b.pocketed).map((b) => { const p = byId2.get(b.id); return p ? { ...p, pos: { x: b.pos.x, y: b.pos.y } } : null; }).filter(Boolean);
      const nf2 = structuredClone(nf1);
      const next2 = variant.applyOutcome(nf2, { firstContact: fc2, potted: potted2, cuePotted: false, cueContacts: [], cushionHits: res2.cushionHits || 0 });
      if (!next2 || next2.foul) continue;
      const redProb = bestNextPotProb({ variant, frame: nf2, pieces: surv2 }, { x: cue2.pos.x, y: cue2.pos.y }, true);
      if (redProb > bestRed) bestRed = redProb;
    }
  }
  return LOOKAHEAD2_WEIGHT * bestRed;
}

// Safety / snooker search (deadly|hard + snooker): when NO makeable pot exists, don't just dribble the
// cue at the nearest ball — try to leave the OPPONENT stuck, ideally SNOOKERED. For the nearest few
// ball-on targets, sweep contact thickness (thin edge → full ball) × pace × spin, simulate each to
// rest, and score the LEAVE with the snooker-aware safety term (scoreOutcome → positionBonus, advanced).
// Illegal outcomes (miss the ball-on, in-off) score hundreds below any legal leave, so only legal
// safeties survive; among them the one that snookers (or leaves the least on) wins. Returns the best
// executable shot, or null if there was nothing legal to try (caller falls back to the plain roll-out).
function safetyShots(state) {
  const variant = state.variant;
  const R = variant.ball.radius;
  const cue = state.pieces.find((p) => p.id === 'cue');
  const cuePos = state.frame.ballInHand || !cue ? variant.defaultPlacement(state) : cue.pos;
  const { pieces, pieceById } = cuePieces(state, cuePos);
  // Consider only the nearest handful of ball-on targets: the realistic safety is played on a ball you
  // can reach cleanly, and this bounds the cost (this whole pass only runs on a no-pot turn).
  const targets = variant.aiTargets(state)
    .map((T) => ({ T, d2: (T.pos.x - cuePos.x) ** 2 + (T.pos.y - cuePos.y) ** 2 }))
    .sort((a, b) => a.d2 - b.d2)
    .slice(0, 6)
    .map((x) => x.T);
  const paces = [0.7, 1.05, 1.5, 2.1, 2.9]; // gentle roll → firm, so the cue can settle in many spots
  const spins = [{ side: 0, vert: 0 }, { side: 0, vert: 0.5 }, { side: 0, vert: -0.5 }, { side: 0.5, vert: 0 }, { side: -0.5, vert: 0 }];
  const thickness = [-0.85, -0.5, 0, 0.5, 0.85]; // thin edge … full … thin edge, as a fraction of the contact half-width
  let best = null;
  for (const T of targets) {
    const toT = v.sub(T.pos, cuePos);
    const d = v.len(toT);
    if (d < 2 * R) continue; // already in contact
    const base = Math.atan2(toT.y, toT.x);
    const half = Math.asin(Math.min(0.999, (2 * R) / d)); // angular half-width that still grazes the target
    for (const f of thickness) {
      const angle = base + f * half;
      for (const sp of paces) {
        const speed = Math.min(MAX_SPEED, sp);
        for (const spin of spins) {
          const score = simScoreP(state, pieces, pieceById, angle, speed, spin, true);
          if (!best || score > best.score) best = { cuePos, angle, speed, spin, score };
        }
      }
    }
  }
  return best;
}

// Pick a shot. Returns { cuePos, angle, speed, spin:{side,vert}, score }. The caller maps
// cuePos → cuePlacement when the frame owes ball-in-hand. opts: maxCandidates / powerScales /
// angleOffsets / spins (search), robust:{ angleErr, speedPct, keep } (play-to-reliability), and
// rng (for the random opening-break style; defaults to Math.random).
// Front half (parallelisable): score the power×angle×spin grid for the candidate lines and return
// the flat `scored` list. A Web Worker pool calls this with slice = { workers, index } to score
// only candidates where i % workers === index; the main thread merges every slice's results. Never
// runs the opening-break path — that stays on the main thread (its random style mustn't fan out).
export function chooseShotGrid(state, opts = {}) {
  const adv = !!opts.advanced;
  const maxCandidates = opts.maxCandidates ?? 8;
  const powerScales = opts.powerScales ?? [0.85, 1.0, 1.25, 1.6];
  const angleOffsets = opts.angleOffsets ?? [-0.012, -0.004, 0, 0.004, 0.012];
  const spins = opts.spins ?? [{ side: 0, vert: 0 }, { side: 0, vert: 0.6 }, { side: 0, vert: -0.6 }];
  const slice = opts.slice ?? null;
  let cands = candidateShots(state).slice(0, maxCandidates);
  if (slice) cands = cands.filter((_, i) => i % slice.workers === slice.index);

  const scored = [];
  for (const c of cands) {
    // pieces/pieceById depend only on the cue position, which is fixed for this candidate's whole
    // power×angle×spin grid — build them once instead of per simulated variant.
    const { pieces, pieceById } = cuePieces(state, c.cuePos);
    for (const ps of powerScales) {
      const speed = Math.max(1.0, Math.min(MAX_SPEED, c.speed * ps));
      for (const ao of angleOffsets) {
        const angle = c.angle + ao;
        for (const sp of spins) {
          const score = simScoreP(state, pieces, pieceById, angle, speed, sp, adv) + c.geom;
          scored.push({ cuePos: c.cuePos, angle, speed, spin: sp, score });
        }
      }
    }
  }
  return scored;
}

// Back half: given the merged grid `scored` (one sync pass, or every worker slice concatenated),
// pick the final shot — sort, optional robustness re-rank, 2-ply cycle refinement, no-pot fallback.
// Runs ONCE on the main thread so the top-K refinements operate on the GLOBAL top candidates,
// identical to the single-threaded path. Mutates `scored` (sorts it in place).
export function chooseShotFinish(state, opts, scored) {
  const variant = state.variant;
  const adv = !!opts.advanced;
  const robust = opts.robust ?? null;
  scored.sort((a, b) => b.score - a.score);

  let best = scored[0] ?? null;
  if (best && robust && (robust.angleErr > 0 || robust.speedPct > 0)) {
    const keep = Math.min(robust.keep ?? 5, scored.length);
    const aMargin = Math.max(robust.angleErr, FORGIVE_ANGLE); // demand at least a forgiveness margin
    const sMargin = Math.max(robust.speedPct, FORGIVE_SPEED);
    best = null;
    for (const cand of scored.slice(0, keep)) {
      let sum = cand.score;
      let worst = cand.score;
      let n = 1;
      for (const da of [-1, 0, 1]) {
        for (const ds of [-1, 0, 1]) {
          if (da === 0 && ds === 0) continue;
          const angle = cand.angle + da * aMargin;
          const speed = Math.max(1.0, Math.min(MAX_SPEED, cand.speed * (1 + ds * sMargin)));
          const s = simScore(state, cand.cuePos, angle, speed, cand.spin, adv);
          sum += s;
          if (s < worst) worst = s;
          n += 1;
        }
      }
      // blend the mean with the WORST perturbed outcome: a knife-edge line (great nominally, wrecked
      // when nudged) loses to a forgiving one that stays good across the neighbourhood.
      const score = (1 - FORGIVE_WORST_W) * (sum / n) + FORGIVE_WORST_W * worst;
      if (!best || score > best.score) best = { ...cand, score };
    }
  }

  // 2-ply refinement (deadly + snooker): re-rank the top ply-1 lines by adding the red→black→red
  // cycle bonus, so the AI prefers a red-pot that also sets up the black AND the red after it.
  if (adv && variant.lookahead2 && scored.length) {
    const K = Math.min(6, scored.length);
    for (const cand of scored.slice(0, K)) {
      const refined = cand.score + cycleBonus(state, cand);
      if (!best || refined > best.score) best = { ...cand, score: refined };
    }
  }
  if (best && best.score > 0) return best;

  // No makeable pot: play the best available SAFETY — try to snooker the opponent — before the blind
  // roll-out. Deadly/hard + snooker only; other variants keep the simple fallback. The safety search
  // scores by the leave, so a shot that snookers (or leaves nothing on) beats one that opens the table.
  // A legal safety scores ≥ 0 (illegal ones sink to −300+), so the > −50 gate keeps only legal lines.
  if (adv && variant.safetyPlay) {
    const safe = safetyShots(state);
    if (safe && safe.score > -50 && (!best || safe.score > best.score)) return safe;
  }

  // No clean pot found: roll toward the nearest legal target (avoids a no-hit foul).
  const cue = state.pieces.find((p) => p.id === 'cue');
  const cuePos = state.frame.ballInHand || !cue ? variant.defaultPlacement(state) : cue.pos;
  const targets = variant.aiTargets(state);
  let tgt = targets[0];
  let dmin = Infinity;
  for (const t of targets) {
    const d = (t.pos.x - cuePos.x) ** 2 + (t.pos.y - cuePos.y) ** 2;
    if (d < dmin) { dmin = d; tgt = t; }
  }
  const angle = tgt ? Math.atan2(tgt.pos.y - cuePos.y, tgt.pos.x - cuePos.x) : 0;
  return { cuePos, angle, speed: 1.6, spin: { side: 0, vert: 0 }, score: best ? best.score : -1000 };
}

export function chooseShot(state, opts = {}) {
  const variant = state.variant;
  const adv = !!opts.advanced; // deadly difficulty enables the advanced AI features

  // Opening break (deadly only): pick a style at RANDOM each frame (safe / attacking / firm), then
  // the best shot for it. Main-thread only (skipped under a worker slice) — the random style and
  // per-style pick must not fan out to a pool, where each worker would choose differently.
  if (adv && !opts.slice && variant.aiBreakShots) {
    const rng = opts.rng ?? Math.random;
    const styles = ['safe', 'attacking', 'firm'];
    const style = styles[Math.min(styles.length - 1, Math.floor(rng() * styles.length))];
    const cands = variant.aiBreakShots(state, style);
    const legal = cands.map((c) => ({ c, e: evalBreak(state, c) })).filter((x) => x.e.legal);
    if (legal.length) {
      let pick;
      if (style === 'safe') {
        // minimise pack disturbance, and prefer the cue returning toward baulk (not stuck up-table)
        const cost = (x) => x.e.spread + 0.3 * Math.max(0, x.e.cueX - x.c.cuePos.x);
        pick = legal.reduce((a, b) => (cost(b) < cost(a) ? b : a));
      } else if (style === 'attacking') {
        pick = legal.reduce((a, b) => (b.e.spread > a.e.spread ? b : a));
      } else {
        // clamp like the style pick above: a custom opts.rng returning exactly 1.0 would otherwise
        // index past the end (Math.random never does, so this changes no current behaviour).
        pick = legal[Math.min(legal.length - 1, Math.floor(rng() * legal.length))];
      }
      return { ...pick.c, score: pick.e.safety };
    }
  }

  return chooseShotFinish(state, opts, chooseShotGrid(state, opts));
}

// Execution error applied to the chosen shot: a random ±angleErr (rad) on the aim and
// ±speedPct on the power. Larger = an easier, less accurate opponent. cuePos is left as chosen.
export function applyError(shot, { angleErr = 0, speedPct = 0 } = {}, rng = Math.random) {
  return {
    ...shot,
    angle: shot.angle + (rng() * 2 - 1) * angleErr,
    speed: Math.max(0.4, Math.min(MAX_SPEED, shot.speed * (1 + (rng() * 2 - 1) * speedPct))),
  };
}

// --- Difficulty model (Milestone E) --------------------------------------------------------------
// Skill = SEARCH breadth (how many candidate lines/spins the AI weighs) + execution NOISE (how
// accurately its hand EXECUTES the chosen shot). Both improve monotonically easy→hard: a harder AI
// searches wider and shakes the aim/power less. ALL tiers run the `advanced` planner (position play,
// safety, sensible break selection) — a beginner still AIMS at the right thing, it just has a shakier
// hand; the pro also plans wider. This models "decides well, executes to skill", the natural split
// (and keeps a beginner from fouling its break for lack of the break-shot logic). `robust` feeds
// chooseShotFinish so a noisier hand also PLANS to its own reliability.
// FULL_SEARCH is the tournament brain: the widest/densest grid (18 candidates, 5 power scales, 5 aim
// samples, 5 spins). BOTH hard and deadly use it, so hard finds the same positional / safety /
// self-pocket-avoiding lines deadly does — they differ only in the HAND. Deadly executes it perfectly
// (zero noise, which also skips the play-to-reliability re-rank so it commits to the best line); hard
// plays it with a small shake, so it's the same smarts a touch less accurately. Ported from the 2D
// renderer's `deadly` profile.
const FULL_SEARCH = { maxCandidates: 18, powerScales: [0.8, 0.95, 1.1, 1.3, 1.6], angleOffsets: [-0.012, -0.006, 0, 0.006, 0.012], spins: [{ side: 0, vert: 0 }, { side: 0, vert: 0.6 }, { side: 0, vert: -0.6 }, { side: 0.5, vert: 0 }, { side: -0.5, vert: 0 }], advanced: true };
// Medium and easy run the SAME advanced planner (positioning, safety, self-pocket avoidance) but over
// a narrower, PLAIN-BALL search: NO spin (a beginner-to-club player keeps it simple — and spinning the
// cue is what made the lower tiers look clumsy), fewer candidate lines, and a shakier hand — so they
// attempt the smart shots to a lesser degree. Breadth steps 8 → 12 → 18 (easy → medium → hard/deadly);
// only hard and deadly use spin.
const MID_SEARCH = { maxCandidates: 12, powerScales: [0.85, 1.0, 1.25, 1.6], angleOffsets: [-0.012, -0.006, 0, 0.006, 0.012], spins: [{ side: 0, vert: 0 }], advanced: true };
const NARROW_SEARCH = { maxCandidates: 8, powerScales: [0.85, 1.1, 1.4], angleOffsets: [-0.008, 0, 0.008], spins: [{ side: 0, vert: 0 }], advanced: true };
export const DIFFICULTIES = {
  easy: { angleErr: 0.03, speedPct: 0.12, search: NARROW_SEARCH },
  medium: { angleErr: 0.015, speedPct: 0.06, search: MID_SEARCH },
  hard: { angleErr: 0.003, speedPct: 0.015, search: FULL_SEARCH }, // deadly's brain, a near-steady hand
  deadly: { angleErr: 0, speedPct: 0, search: FULL_SEARCH }, // deadly's brain, a perfect hand
};

// Resolve a difficulty (a DIFFICULTIES key or an explicit {angleErr, speedPct, search} object) into
// its tier `d` and the search/robustness `config` that chooseShot(Grid|Finish) consume. Shared by
// aiTurn (sync) and the renderer's off-thread worker path, so both build the SAME search. `rng`
// seeds only the opening-break style pick (grid scoring itself is rng-free) → identical everywhere.
export function difficultyConfig(difficulty = 'medium', rng = Math.random) {
  const d = typeof difficulty === 'string' ? (DIFFICULTIES[difficulty] ?? DIFFICULTIES.medium) : difficulty;
  return { d, config: { ...d.search, robust: { angleErr: d.angleErr, speedPct: d.speedPct }, rng } };
}

// Map a chosen (intended) shot to the EXECUTABLE shot game.takeShot wants: apply the tier's
// execution noise, and when the frame owes ball-in-hand promote the chosen cuePos to cuePlacement.
// Shared so the sync aiTurn and the worker path finish a decision identically.
export function executeShot(state, d, intended, rng = Math.random) {
  const executed = applyError(intended, d, rng);
  return state.frame.ballInHand ? { ...executed, cuePlacement: executed.cuePos } : executed;
}

// Decide AND execute one AI turn, deterministically. Returns an EXECUTABLE shot
//   { cuePos, angle, speed, spin:{side,vert}, cuePlacement? }
// ready to hand to game.takeShot. Guarantees a LEGAL shot for any non-terminal state (chooseShot's
// own no-pot fallback rolls the cue toward the nearest legal target, so it never returns "nothing").
// `rng` is a seeded PRNG → (state, seed, difficulty) replays identically. `difficulty` is a key of
// DIFFICULTIES or an explicit {angleErr, speedPct, search} object.
export function aiTurn(state, { difficulty = 'medium', rng = Math.random } = {}) {
  const { d, config } = difficultyConfig(difficulty, rng);
  return executeShot(state, d, chooseShot(state, config), rng);
}
