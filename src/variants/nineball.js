// variants/nineball.js — 9-ball pool. Same table/ball as 8-ball; different balls and rules.
//
// Rules: you must strike the LOWEST-numbered ball on the table first, but any ball potted on a
// legal shot counts and you continue (combinations are legal). Foul (wrong/no first contact or
// a scratch) → opponent gets ball-in-hand. Legally pot the 9-ball to win (a combo off the
// lowest ball counts). The 9 potted on a foul is re-spotted; other balls potted stay down.

import * as v from '../vec2.js';

const BALL = { radius: 0.028575, mass: 0.17 };
const TABLE = { width: 2.24, height: 1.12, cornerPocket: 0.07, middlePocket: 0.065 };
const HX = TABLE.width / 2;
const HY = TABLE.height / 2;
const R = BALL.radius;
const FOOT_X = HX / 2;
const HEAD_X = -HX / 2;

const BASE = ['#e7c63b', '#2156b0', '#c0241f', '#6a3da8', '#e07b1a', '#1f7a43', '#7a1f2b']; // 1..7
const colorByNumber = (n) => (n === 8 ? '#1a1a1a' : n === 9 ? '#e7c63b' : BASE[n - 1]);

const bounds = () => ({ minX: -HX, maxX: HX, minY: -HY, maxY: HY });
const pockets = () => [
  { center: { x: -HX, y: -HY }, radius: TABLE.cornerPocket },
  { center: { x: HX, y: -HY }, radius: TABLE.cornerPocket },
  { center: { x: -HX, y: HY }, radius: TABLE.cornerPocket },
  { center: { x: HX, y: HY }, radius: TABLE.cornerPocket },
  { center: { x: 0, y: -HY }, radius: TABLE.middlePocket },
  { center: { x: 0, y: HY }, radius: TABLE.middlePocket },
];

// 9-ball diamond: 1 at the apex (nearest the cue), 9 in the centre, rows 1-2-3-2-1.
const NUMS = [1, 2, 3, 4, 9, 5, 6, 7, 8];
const ROW_COUNT = [1, 2, 3, 2, 1];
function rack() {
  const gap = 0.0006;
  const rowDx = R * Math.sqrt(3) + gap;
  const pieces = [{ id: 'cue', number: 0, group: 'cue', color: '#f5f3ea', kind: 'cue', pos: { x: HEAD_X, y: 0 } }];
  let idx = 0;
  for (let row = 0; row < 5; row++) {
    const x = FOOT_X + row * rowDx;
    const count = ROW_COUNT[row];
    for (let i = 0; i < count; i++) {
      const num = NUMS[idx];
      pieces.push({ id: `b${num}`, number: num, group: num === 9 ? 'stripe' : 'solid', color: colorByNumber(num), kind: 'object', pos: { x, y: (i - (count - 1) / 2) * (2 * R + gap) } });
      idx += 1;
    }
  }
  return pieces;
}

const playerName = (t) => `Player ${t + 1}`;
function newFrame() {
  return { turn: 0, ballInHand: true, remaining: [1, 2, 3, 4, 5, 6, 7, 8, 9], frameOver: false, winner: null, message: 'Player 1 to break' };
}
const lowest = (frame) => Math.min(...frame.remaining);

const within = (x, y) => x >= -HX + R && x <= HX - R && y >= -HY + R && y <= HY - R;
const noOverlap = (state, x, y) => state.pieces.every((p) => p.id === 'cue' || Math.hypot(p.pos.x - x, p.pos.y - y) >= 2 * R + 1e-3);

function applyOutcome(frame, info) {
  const { firstContact = null, potted = [], cuePotted = false } = info;
  const me = frame.turn;
  const opp = 1 - me;
  const low = lowest(frame);
  const events = [];
  let foul = false;

  if (!firstContact) { foul = true; events.push('Foul: no ball hit'); }
  else if (firstContact.number !== low) { foul = true; events.push(`Foul: must hit the ${low} first`); }
  if (cuePotted) { foul = true; events.push('Foul: cue scratched'); }

  const pottedNine = potted.some((p) => p.number === 9);
  for (const p of potted) frame.remaining = frame.remaining.filter((n) => n !== p.number);

  if (pottedNine && !foul) {
    frame.frameOver = true;
    frame.winner = me;
    events.push(`Player ${me + 1} pots the 9 — wins!`);
    frame.message = events.join(' · ');
    return { events, foul: false, continues: false, message: frame.message, respot: [] };
  }

  const respot = [];
  if (pottedNine && foul) { frame.remaining.push(9); respot.push('9'); } // illegal 9 → re-spot

  if (foul) {
    frame.ballInHand = true;
    frame.turn = opp;
    events.push(`Foul — ${playerName(opp)} ball in hand`);
    frame.message = events.join(' · ');
    return { events, foul: true, continues: false, message: frame.message, respot };
  }

  const continues = potted.length > 0;
  if (!continues) { frame.turn = opp; events.push(`${playerName(me)} — no pot`); }
  else events.push(`${playerName(me)} pots ${potted.length}`);
  frame.message = events.join(' · ');
  return { events, foul: false, continues, message: frame.message, respot };
}

function lowestPiece(state) {
  const low = lowest(state.frame);
  return state.pieces.find((p) => p.number === low) ?? null;
}

export const nineball = {
  id: 'nineball',
  name: '9-Ball Pool',
  ball: { radius: BALL.radius, mass: BALL.mass },
  rackJitter: 0.0009, // ~0.9 mm: breaks the dead-centre symmetry so the pack actually scatters
  cloth: '#13557a',
  cueColor: '#f5f3ea',
  rulesText: [
    'Always strike the lowest-numbered ball on the table first.',
    'Any ball potted on a legal shot counts and you stay at the table — combinations are allowed.',
    'Foul (wrong or no first contact, or a scratch): the opponent gets ball-in-hand.',
    'Legally pot the 9-ball to win (a combo off the lowest ball counts). The 9 potted on a foul is re-spotted.',
  ],
  bounds,
  pockets,
  rack,
  newFrame,
  applyOutcome,
  respotPiece(state, color) {
    // re-spot the 9 on the foot spot (or nearest clear point toward the foot rail)
    let x = FOOT_X;
    while (x < HX - R && !noOverlap(state, x, 0)) x += 2 * R;
    return { id: 'b9', number: 9, group: 'stripe', color: colorByNumber(9), kind: 'object', pos: { x, y: 0 } };
  },

  ballInHandLabel: 'Ball in hand — place the cue anywhere clear',
  placementLegal: (state, x, y) => within(x, y) && noOverlap(state, x, y),
  defaultPlacement(state) {
    const desired = { x: HEAD_X, y: 0 };
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

  aiTargets: (state) => { const p = lowestPiece(state); return p ? [p] : []; },
  aiLegalFirst: (frame, piece) => piece != null && piece.number === lowest(frame),
  aiLegalPot: () => true, // any ball potted on a legal shot counts
  aiValue: () => 100,
  aiWinBonus: (frame, piece) => (piece.number === 9 ? 5000 : 0),
  aiPenalty: () => 0,
  aiPlacements(state) {
    const t = lowestPiece(state);
    if (!t) return [this.defaultPlacement(state)];
    const out = [];
    for (const pk of pockets()) {
      const dir = v.normalize(v.sub(pk.center, t.pos));
      const pos = v.sub(v.sub(t.pos, v.scale(dir, 2 * R)), v.scale(dir, 0.3));
      if (within(pos.x, pos.y) && noOverlap(state, pos.x, pos.y)) out.push(pos);
    }
    out.push(this.defaultPlacement(state));
    return out;
  },

  colorOf: (piece) => piece.color,
  isStripe: (piece) => piece.number === 9,
  label: (piece) => (piece.group === 'cue' ? '' : String(piece.number)),
  drawMarkings(ctx, h) {
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

  sideValue: () => '—',
  centerText: (frame) => (frame.frameOver ? '' : `on: ${lowest(frame)}`),
};
