// variants/pool.js — 8-ball pool as a variant. Reuses the shared physics engine; only the
// table, rack, rules and AI targeting differ from snooker.
//
// Rules (singles, simplified-but-faithful 8-ball):
//   • Break from the kitchen; the table is "open" until someone legally pots a solid or stripe,
//     which assigns the groups. Pot your group to keep the table.
//   • Foul (scratch the cue, no ball hit, or hit the wrong group / the 8 first) → opponent gets
//     ball-in-hand (place anywhere). Potted balls stay down.
//   • Clear your group, then pot the 8 to win. Potting the 8 early, or scratching while potting
//     it, loses the frame.
// Not modelled: the no-rail-after-contact foul, 8-on-the-break re-rack, behind-the-head-string
// restriction after a break scratch (ball-in-hand is allowed anywhere).

import * as v from '../vec2.js';

const BALL = { radius: 0.028575, mass: 0.17 }; // 57.15 mm, ~170 g
const TABLE = { width: 2.24, height: 1.12, cornerPocket: 0.07, middlePocket: 0.065 };
const HX = TABLE.width / 2;
const HY = TABLE.height / 2;
const R = BALL.radius;
const FOOT_X = HX / 2; // foot spot (rack apex)
const HEAD_X = -HX / 2; // head string (break from behind this)

const BASE = ['#e7c63b', '#2156b0', '#c0241f', '#6a3da8', '#e07b1a', '#1f7a43', '#7a1f2b']; // 1..7
const colorByNumber = (n) => (n === 0 ? '#f5f3ea' : n === 8 ? '#1a1a1a' : BASE[(n > 7 ? n - 8 : n) - 1]);
const groupOf = (n) => (n === 8 ? 'eight' : n <= 7 ? 'solid' : 'stripe');

const bounds = () => ({ minX: -HX, maxX: HX, minY: -HY, maxY: HY });
const pockets = () => [
  { center: { x: -HX, y: -HY }, radius: TABLE.cornerPocket },
  { center: { x: HX, y: -HY }, radius: TABLE.cornerPocket },
  { center: { x: -HX, y: HY }, radius: TABLE.cornerPocket },
  { center: { x: HX, y: HY }, radius: TABLE.cornerPocket },
  { center: { x: 0, y: -HY }, radius: TABLE.middlePocket },
  { center: { x: 0, y: HY }, radius: TABLE.middlePocket },
];

// 15-ball rack: apex on the foot spot, 8 in the centre, back corners a solid + a stripe.
const NUMS = [1, 9, 2, 10, 8, 3, 11, 4, 12, 5, 13, 6, 14, 15, 7];
function rack() {
  const gap = 0.0006;
  const rowDx = R * Math.sqrt(3) + gap;
  const pieces = [{ id: 'cue', number: 0, group: 'cue', color: colorByNumber(0), kind: 'cue', pos: { x: HEAD_X - 0.18, y: 0 } }];
  let idx = 0;
  for (let row = 0; row < 5; row++) {
    const x = FOOT_X + row * rowDx;
    for (let i = 0; i <= row; i++) {
      const num = NUMS[idx];
      pieces.push({ id: `b${num}`, number: num, group: groupOf(num), color: colorByNumber(num), kind: 'object', pos: { x, y: (i - row / 2) * (2 * R + gap) } });
      idx += 1;
    }
  }
  return pieces;
}

function newFrame() {
  return {
    turn: 0,
    open: true,
    assigned: [null, null], // 'solid' | 'stripe' per player
    remaining: { solid: 7, stripe: 7 },
    ballInHand: true,
    frameOver: false,
    winner: null,
    message: 'Player 1 to break',
  };
}

// What group the player is "on": 'open', 'solid'/'stripe', or 'eight' once their group is clear.
function onGroup(frame, player) {
  if (frame.open) return 'open';
  const g = frame.assigned[player];
  return frame.remaining[g] === 0 ? 'eight' : g;
}

function legalFirst(frame, piece, player = frame.turn) {
  if (!piece) return false;
  const on = onGroup(frame, player);
  if (on === 'eight') return piece.group === 'eight';
  if (on === 'open') return piece.group !== 'eight';
  return piece.group === on;
}
function legalPot(frame, piece, player = frame.turn) {
  const on = onGroup(frame, player);
  if (on === 'eight') return piece.group === 'eight';
  if (on === 'open') return piece.group !== 'eight';
  return piece.group === on;
}

function applyOutcome(frame, info) {
  const { firstContact = null, potted = [], cuePotted = false } = info;
  const me = frame.turn;
  const opp = 1 - me;
  const on = onGroup(frame, me);
  const events = [];
  let foul = false;

  if (!firstContact) { foul = true; events.push('Foul: no ball hit'); }
  else if (!legalFirst(frame, firstContact)) {
    foul = true;
    events.push(on === 'eight' ? 'Foul: must hit the 8' : on === 'open' ? 'Foul: hit the 8 on an open table' : `Foul: must hit ${on}s first`);
  }
  if (cuePotted) { foul = true; events.push('Foul: cue scratched'); }

  // remove potted object balls from the running counts
  const pottedEight = potted.some((p) => p.group === 'eight');
  for (const p of potted) if (p.group === 'solid' || p.group === 'stripe') frame.remaining[p.group] -= 1;

  // the 8 ends the frame either way
  if (pottedEight) {
    const clean = !foul && on === 'eight';
    frame.frameOver = true;
    frame.winner = clean ? me : opp;
    events.push(clean ? `Player ${me + 1} pots the 8 — wins!` : `Player ${opp + 1} wins (8 potted illegally)`);
    frame.message = events.join(' · ');
    return { events, foul, continues: false, message: frame.message, respot: [] };
  }

  // assign groups on an open table after a legal pot
  if (!foul && on === 'open') {
    const grp = potted.find((p) => p.group === 'solid' || p.group === 'stripe')?.group;
    if (grp) {
      frame.open = false;
      frame.assigned[me] = grp;
      frame.assigned[opp] = grp === 'solid' ? 'stripe' : 'solid';
      events.push(`Player ${me + 1} is ${grp}s`);
    }
  }

  if (foul) {
    frame.ballInHand = true;
    frame.turn = opp;
    events.push(`Foul — Player ${opp + 1} ball in hand`);
    frame.message = events.join(' · ');
    return { events, foul: true, continues: false, message: frame.message, respot: [] };
  }

  // legal pots: your group, or anything (non-8) while the table was open
  let legalPots = 0;
  for (const p of potted) {
    if (p.group === 'eight') continue;
    if (on === 'open' || p.group === frame.assigned[me]) legalPots += 1;
  }
  const continues = legalPots > 0;
  if (!continues) { frame.turn = opp; events.push(`Player ${me + 1} — no pot`); }
  else events.push(`Player ${me + 1} pots ${legalPots}`);
  frame.message = events.join(' · ');
  return { events, foul: false, continues, message: frame.message, respot: [] };
}

const within = (x, y) => x >= -HX + R && x <= HX - R && y >= -HY + R && y <= HY - R;
const noOverlap = (state, x, y) => state.pieces.every((p) => p.id === 'cue' || Math.hypot(p.pos.x - x, p.pos.y - y) >= 2 * R + 1e-3);

function aiTargets(state) {
  const f = state.frame;
  const on = onGroup(f, f.turn);
  if (on === 'eight') return state.pieces.filter((p) => p.group === 'eight');
  if (on === 'open') return state.pieces.filter((p) => p.group !== 'eight' && p.group !== 'cue');
  return state.pieces.filter((p) => p.group === on);
}

export const pool = {
  id: 'pool',
  name: '8-Ball Pool',
  ball: { radius: BALL.radius, mass: BALL.mass },
  rackJitter: 0.0009, // ~0.9 mm: breaks the dead-centre symmetry so the pack actually scatters
  cloth: '#13557a',
  cueColor: '#f5f3ea',
  rulesText: [
    'Break, then the table is "open" until someone legally pots a solid or a stripe — that assigns the groups.',
    'Pot a ball from your group to stay at the table.',
    'Foul (scratch the cue, hit nothing, or hit the wrong group / the 8 first): the opponent gets ball-in-hand.',
    'Clear your group, then pot the 8 to win. Potting the 8 early — or scratching while potting it — loses.',
  ],
  bounds,
  pockets,
  rack,
  newFrame,
  applyOutcome,
  respotPiece: () => null, // pool never re-spots

  ballInHandLabel: 'Ball in hand — place the cue anywhere clear',
  placementLegal: (state, x, y) => within(x, y) && noOverlap(state, x, y),
  defaultPlacement(state) {
    const desired = { x: HEAD_X - 0.15, y: 0 };
    if (within(desired.x, desired.y) && noOverlap(state, desired.x, desired.y)) return desired;
    for (let rad = 2 * R; rad < 0.5; rad += R)
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        const x = desired.x + Math.cos(a) * rad;
        const y = desired.y + Math.sin(a) * rad;
        if (within(x, y) && noOverlap(state, x, y)) return { x, y };
      }
    return desired;
  },

  aiTargets,
  aiLegalFirst: legalFirst,
  aiLegalPot: legalPot,
  aiValue: () => 100,
  aiWinBonus: (frame, piece) => (piece.group === 'eight' && onGroup(frame, frame.turn) === 'eight' ? 5000 : 0),
  aiPenalty: (frame, piece) => (piece.group === 'eight' ? 5000 : 120), // potting the 8 illegally loses
  aiPlacements(state) {
    // ball-in-hand: line up a straight pot behind each legal target's nearest pocket
    const out = [];
    for (const t of aiTargets(state)) {
      let best = null;
      let dmin = Infinity;
      for (const pk of pockets()) {
        const d = Math.hypot(pk.center.x - t.pos.x, pk.center.y - t.pos.y);
        if (d < dmin) { dmin = d; best = pk; }
      }
      if (!best) continue;
      const dir = v.normalize(v.sub(best.center, t.pos));
      const ghost = v.sub(t.pos, v.scale(dir, 2 * R));
      const pos = v.sub(ghost, v.scale(dir, 0.3)); // 0.3 m behind, in line → near-straight pot
      if (within(pos.x, pos.y) && noOverlap(state, pos.x, pos.y)) out.push(pos);
    }
    out.push(this.defaultPlacement(state));
    return out;
  },

  colorOf: (piece) => piece.color,
  isStripe: (piece) => piece.group === 'stripe',
  label: (piece) => (piece.group === 'cue' ? '' : String(piece.number)),
  drawMarkings(ctx, h) {
    // head string + head & foot spots
    ctx.strokeStyle = 'rgba(230,230,230,0.4)';
    ctx.lineWidth = 1.2;
    const a = h.toPx(HEAD_X, HY);
    const b = h.toPx(HEAD_X, -HY);
    ctx.beginPath(); ctx.moveTo(a.px, a.py); ctx.lineTo(b.px, b.py); ctx.stroke();
    ctx.fillStyle = 'rgba(230,230,230,0.5)';
    for (const sx of [FOOT_X, HEAD_X]) {
      const p = h.toPx(sx, 0);
      ctx.beginPath(); ctx.arc(p.px, p.py, 2, 0, Math.PI * 2); ctx.fill();
    }
  },

  sideValue(frame, i) {
    if (frame.open || !frame.assigned[i]) return '—';
    const g = frame.assigned[i];
    return frame.remaining[g] === 0 ? 'on 8' : `${g}s ${frame.remaining[g]}`;
  },
  centerText(frame) {
    if (frame.frameOver) return '';
    if (frame.open) return 'open table';
    return onGroup(frame, frame.turn) === 'eight' ? 'on the 8' : `${frame.assigned[frame.turn]}s`;
  },
};
