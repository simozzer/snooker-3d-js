// game.js — ties the physics engine to a game VARIANT (snooker or pool). The variant supplies
// geometry, rack, rules, AI targeting and rendering; this file is variant-agnostic glue:
//   1. build physics balls from the pieces (placing the cue in-hand if owed),
//   2. simulate to rest,
//   3. classify the cue's first contact + what was potted,
//   4. apply the variant's rules, then reconcile the table (drop potted, re-spot, update rests).

import { Ball } from './motion.js';
import { simulate } from './simulate.js';
import { snooker } from './variants/snooker.js';

// A fully-deterministic AI (e.g. Deadly, zero execution noise) can livelock: replaying an identical
// shot from a position that keeps returning to itself, forever. We end the frame as a stalemate once
// a position signature recurs this many times with no pot in between (real snooker re-racks a genuine
// stalemate; ending the frame is the toy-scale equivalent that guarantees termination).
const STALEMATE_REPEATS = 3;

// Variant-agnostic signature of the table: every ball's id + position. Rounded to 1 mm — a genuine
// deterministic livelock reproduces the layout near-exactly, so 1 mm catches it while keeping distinct
// positions from aliasing together (a false stalemate). No rules state here, so it works for any game.
function positionSignature(state) {
  const q = (v) => Math.round(v / 0.001);
  return state.pieces.map((p) => `${p.id}:${q(p.pos.x)}:${q(p.pos.y)}`).sort().join('|');
}

// A small random nudge to each racked ball so no two frames play out identically — a break is
// chaotically sensitive, so even a sub-visible offset diverges the run. A bigger nudge also
// breaks the perfect symmetry of a dead-centre break (which otherwise passes energy straight
// through the pack), so the pool/9-ball racks use a larger value (variant.rackJitter) to make the
// pack actually scatter. After nudging we relax any overlap a tight rack may now have, leaving
// balls just-touching rather than interpenetrating. Pass { jitter: 0 } for a deterministic layout.
const PLACEMENT_JITTER = 0.00025; // metres — default (snooker/billiards); pool/9-ball override it

function jitterPlacements(pieces, r, b, mag, rng) {
  if (mag <= 0) return;
  for (const p of pieces) {
    const x = p.pos.x + (rng() * 2 - 1) * mag;
    const y = p.pos.y + (rng() * 2 - 1) * mag;
    p.pos = { x: Math.max(b.minX + r, Math.min(b.maxX - r, x)), y: Math.max(b.minY + r, Math.min(b.maxY - r, y)) };
  }
  relaxOverlaps(pieces, r, b); // a larger nudge can overlap a tight rack → settle to just-touching
}

export function newGame(variant = snooker, { jitter, rng = Math.random } = {}) {
  const pieces = variant.rack();
  const mag = jitter ?? variant.rackJitter ?? PLACEMENT_JITTER; // jitter:0 stays 0 (deterministic)
  jitterPlacements(pieces, variant.ball.radius, variant.bounds(), mag, rng);
  return { variant, frame: variant.newFrame(), pieces };
}

export function buildBalls(pieces, ball) {
  return pieces.map(
    (p) => new Ball({ id: p.id, kind: p.kind, color: p.color, pos: { x: p.pos.x, y: p.pos.y }, radius: ball.radius, mass: ball.mass }),
  );
}

// Final-state de-overlap: a velocity impulse can't undo positional interpenetration, so a tight
// cluster can settle with balls overlapping by a hair. This relaxes the SETTLED positions only
// (a constraint sweep: push overlapping pairs apart, keep them on the table) — it doesn't touch
// the replayed dynamics, just guarantees a clean resting layout. Uniform radius per variant.
function relaxOverlaps(pieces, r, b, iters = 20) {
  const minD = 2 * r;
  for (let it = 0; it < iters; it++) {
    let moved = false;
    for (let i = 0; i < pieces.length; i++) {
      for (let j = i + 1; j < pieces.length; j++) {
        const a = pieces[i].pos;
        const c = pieces[j].pos;
        const dx = a.x - c.x;
        const dy = a.y - c.y;
        let d = Math.hypot(dx, dy);
        if (d >= minD - 1e-9) continue;
        if (d < 1e-9) { d = 1e-9; } // coincident: nudge along x
        const nx = d > 1e-9 ? dx / d : 1;
        const ny = d > 1e-9 ? dy / d : 0;
        const push = (minD - d) / 2 + 1e-6;
        a.x += nx * push; a.y += ny * push;
        c.x -= nx * push; c.y -= ny * push;
        moved = true;
      }
    }
    for (const p of pieces) {
      p.pos.x = Math.max(b.minX + r, Math.min(b.maxX - r, p.pos.x));
      p.pos.y = Math.max(b.minY + r, Math.min(b.maxY - r, p.pos.y));
    }
    if (!moved) break;
  }
}

// Take a shot. cuePlacement (a legal in-hand position) is used when the frame owes ball-in-hand.
// spin = { side, vert } cue-tip offsets in −1..1. elevation (radians) raises the cue for a jump shot
// (0 = normal); it must reach the engine or the human's jump slider is silently dropped here.
export function takeShot(state, { angle, speed, spin = {}, cuePlacement = null, elevation = 0 } = {}) {
  const variant = state.variant;
  // Snapshot the table + frame BEFORE the shot, so the miss rule can recall it (opponent makes the
  // offender play again from here). Cheap deep copies; only used if the shot turns out to be a miss.
  const preShot = { pieces: structuredClone(state.pieces), frame: structuredClone(state.frame) };
  let cue = state.pieces.find((p) => p.id === 'cue');
  if (state.frame.ballInHand) {
    const pos = cuePlacement || variant.defaultPlacement(state);
    if (cue) cue.pos = { ...pos };
    else {
      cue = { id: 'cue', color: variant.cueColor, group: 'cue', kind: 'cue', pos: { ...pos } };
      state.pieces.push(cue);
    }
    state.frame.ballInHand = false;
  }

  const balls = buildBalls(state.pieces, variant.ball);
  const pieceById = new Map(state.pieces.map((p) => [p.id, p]));
  const meta = new Map(
    balls.map((b) => {
      const p = pieceById.get(b.id);
      return [b.id, { radius: b.radius, fill: variant.colorOf(p), stripe: variant.isStripe(p), label: variant.label(p) }];
    }),
  );
  const res = simulate({ balls, bounds: variant.bounds(), pockets: variant.pockets() }, { ballId: 'cue', angle, speed, spin, elevation }, { contactBall: 'cue' });

  const byId = new Map(balls.map((b) => [b.id, b]));
  // A `cleared` ball leapt the cushion and left the playing surface (only reachable via a human jump
  // shot; the AI never elevates). For frame purposes a ball off the table is treated like a potted
  // ball — removed, colours re-spotted, a cleared cue is an in-off — so the game loop stays robust
  // rather than trying to keep a ball at an off-table resting position.
  const pottedIds = new Set([...res.pocketed, ...(res.cleared || [])]);
  const cuePotted = pottedIds.has('cue');
  const potted = [];
  for (const id of pottedIds) {
    if (id === 'cue') continue;
    potted.push(pieceById.get(id));
  }
  const firstContact = res.firstContact ? pieceById.get(res.firstContact) : null;
  const cueContacts = (res.cueContacts || []).map((id) => pieceById.get(id)).filter(Boolean);

  // Could the striker have hit the ball-on from where the cue started? (Feeds the miss rule.)
  const canHitBallOn = variant.canHitBallOn && cue ? variant.canHitBallOn(state, cue.pos) : true;
  const outcome = variant.applyOutcome(state.frame, { firstContact, potted, cuePotted, cueContacts, cushionHits: res.cushionHits || 0, canHitBallOn });

  // reconcile the table: keep survivors at their settled positions
  state.pieces = state.pieces
    .filter((p) => !pottedIds.has(p.id))
    .map((p) => ({ ...p, pos: { x: byId.get(p.id).pos.x, y: byId.get(p.id).pos.y } }));

  // re-spot whatever the rules return (snooker colours; pool returns nothing)
  for (const color of outcome.respot) {
    const rp = variant.respotPiece(state, color);
    if (rp) state.pieces.push(rp);
  }

  // clean up any hair-thin interpenetration left by a tight cluster settling
  relaxOverlaps(state.pieces, variant.ball.radius, variant.bounds());

  // FREE BALL: a foul that leaves the incoming player snookered (no direct line to any ball-on) awards
  // them a free ball on the next stroke. Not when they get ball-in-hand (they can place a clear shot),
  // nor when the frame is over. Judged from the cue's settled position on the incoming player's ball-on.
  if (outcome.foul && !state.frame.frameOver && !state.frame.ballInHand && variant.canHitBallOn) {
    const cueRest = state.pieces.find((p) => p.id === 'cue');
    if (cueRest && !variant.canHitBallOn(state, cueRest.pos)) {
      state.frame.freeBall = true;
      outcome.freeBall = true; // surfaced to the renderer for the "FREE BALL" indicator
    }
  }

  // stalemate guard — break a deterministic livelock (see STALEMATE_REPEATS). A pot is progress, so
  // it resets the history; a repeated scoreless position eventually ends the frame instead of looping.
  if (!state.frame.frameOver) {
    if (pottedIds.size > 0) state._posSeen = null;
    const seen = state._posSeen ?? (state._posSeen = new Map());
    const sig = positionSignature(state);
    const n = (seen.get(sig) || 0) + 1;
    seen.set(sig, n);
    if (n >= STALEMATE_REPEATS) {
      state.frame.frameOver = true;
      const [a, b] = state.frame.scores;
      state.frame.winner = a === b ? 'tie' : a > b ? 0 : 1;
      state.frame.message = state.frame.winner === 'tie'
        ? `Stalemate — frame tied ${a}–${b}`
        : `Stalemate — Player ${state.frame.winner + 1} wins ${Math.max(a, b)}–${Math.min(a, b)}`;
      outcome.message = state.frame.message;
    }
  }

  // `preShot` lets the renderer recall a MISS (restore the table + frame, offender plays again).
  return { timeline: res.timeline, meta, outcome, preShot };
}
