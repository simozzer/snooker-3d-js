// variants/carrom.js — Carrom as a variant, a nod to the 2D carrom game this project grew out of.
// Reuses the shared physics engine (top-down sliding + collisions + corner pockets); only the square
// board, the flower rack, the striker-on-a-baseline mechanic, the rules and AI targeting differ.
//
// Rules (singles, simplified-but-faithful):
//   • 19 men (9 white, 9 black) + the red Queen packed in a central circle; a striker is placed on the
//     player's baseline each turn and flicked.
//   • The board is "open" until someone pots a man — that player takes that colour; the opponent the other.
//   • Pot one of YOUR men to keep striking. Potting the opponent's man just gives it to them.
//   • The Queen must be COVERED: pot one of your own men on the same or a later stroke of the same break,
//     else the Queen goes back to the centre. A covered Queen is worth a +3 bonus.
//   • Foul (pot the striker, or strike no piece): turn passes; any men (and the Queen) potted this stroke
//     go back to the centre.
//   • Clear all your men to win the frame.
// Not modelled: the "due" piece penalty, the queen-before-your-last-man requirement, 4-player sides.

import * as v from '../vec2.js';

const BALL = { radius: 0.02, mass: 0.005 }; // a carrom man ~40 mm, ~5 g (striker shares the size)
const HX = 0.45; // half-width of the square playing bed (0.90 m board)
const HY = 0.45;
const R = BALL.radius;
const POCKET = 0.042; // corner-hole capture radius
const BY = 0.32; // baseline distance from centre (each player's striking line)
const BLX = 0.30; // half-length of the baseline (the striker slides between the end circles)
const CENTRE_R = 0.075; // the central circle the men are racked inside

const COLORS = { white: '#e9e2cf', black: '#26262b', queen: '#b3202b', cue: '#d8b24a' };

const bounds = () => ({ minX: -HX, maxX: HX, minY: -HY, maxY: HY });
// Four corner pockets only — corners always capture (no middle pockets on a carrom board).
const pockets = () => [
  { center: { x: -HX, y: -HY }, radius: POCKET, mouth: POCKET * 1.25 },
  { center: { x: HX, y: -HY }, radius: POCKET, mouth: POCKET * 1.25 },
  { center: { x: -HX, y: HY }, radius: POCKET, mouth: POCKET * 1.25 },
  { center: { x: HX, y: HY }, radius: POCKET, mouth: POCKET * 1.25 },
];

// The flower rack: the Queen in the centre, a ring of 6, then a ring of 12, packed touching. Colours
// alternate so it reads as a proper carrom board and totals 9 white + 9 black.
function rack() {
  const gap = 0.0009;
  const d = 2 * R + gap;
  const spots = [];
  for (let i = 0; i < 6; i++) { const a = i * Math.PI / 3; spots.push({ x: Math.cos(a) * d, y: Math.sin(a) * d }); }
  for (let i = 0; i < 6; i++) { const a = i * Math.PI / 3; spots.push({ x: Math.cos(a) * 2 * d, y: Math.sin(a) * 2 * d }); }
  for (let i = 0; i < 6; i++) { const a = (i + 0.5) * Math.PI / 3; spots.push({ x: Math.cos(a) * Math.sqrt(3) * d, y: Math.sin(a) * Math.sqrt(3) * d }); }
  const pieces = [{ id: 'queen', color: 'queen', kind: 'object', pos: { x: 0, y: 0 } }];
  let w = 0, b = 0;
  spots.forEach((s, i) => {
    const white = i % 2 === 0;
    const color = white ? 'white' : 'black';
    const n = white ? ++w : ++b;
    pieces.push({ id: `${color}${n}`, color, kind: 'object', pos: s });
  });
  // the striker starts on player 1's baseline (bottom)
  pieces.push({ id: 'cue', color: 'cue', group: 'cue', kind: 'cue', pos: { x: 0, y: -BY } });
  return pieces;
}

function newFrame() {
  return {
    turn: 0,
    scores: [0, 0], // men pocketed (HUD; a covered Queen adds +3)
    open: true, // colours not yet claimed
    assigned: [null, null], // 'white' | 'black' per player
    remaining: { white: 9, black: 9 },
    queenPending: false, // Queen pocketed this break, awaiting a cover
    queenOwner: null, // who must cover it
    queenAwarded: null, // who ended up with the Queen
    ballInHand: true, // the striker is placed on the baseline every turn
    frameOver: false,
    winner: null,
    message: 'Player 1 to break',
  };
}

const clear = (state, x, y, skip = 'cue') => state.pieces.every((p) => p.id === skip || Math.hypot(p.pos.x - x, p.pos.y - y) >= 2 * R + 1e-3);
const baselineY = (frame) => (frame.turn === 0 ? -BY : BY);

function applyOutcome(frame, info) {
  const { firstContact = null, potted = [], cuePotted = false } = info;
  const me = frame.turn, opp = 1 - me;
  const events = [];
  const respot = [];
  let foul = false;

  const queenPotted = potted.some((p) => p.color === 'queen');
  const men = potted.filter((p) => p.color === 'white' || p.color === 'black');
  const menOff = () => { for (const p of men) frame.remaining[p.color] -= 1; }; // leave the board

  // --- fouls: pocket the striker, or strike no piece ---
  if (cuePotted) { foul = true; events.push('Foul: striker pocketed'); }
  if (!firstContact) { foul = true; events.push('Foul: struck no piece'); }

  if (foul) {
    // this stroke's potted men (and the Queen) go back to the centre; play passes
    for (const p of men) respot.push(p.color);
    if (queenPotted) respot.push('queen');
    frame.turn = opp;
    frame.ballInHand = true;
    events.push(`Foul — Player ${opp + 1} to play`);
    frame.message = events.join(' · ');
    return { events, foul: true, continues: false, respot, message: frame.message };
  }

  // --- a legal stroke: claim a colour on the first man potted while open ---
  if (frame.open && men.length) {
    const w = men.filter((p) => p.color === 'white').length;
    const claim = w >= men.length - w ? 'white' : 'black';
    frame.open = false;
    frame.assigned[me] = claim;
    frame.assigned[opp] = claim === 'white' ? 'black' : 'white';
    events.push(`Player ${me + 1} plays ${claim}`);
  }
  const myColor = frame.assigned[me], oppColor = frame.assigned[opp];

  // --- Queen: only playable once colours are decided; otherwise it returns ---
  if (queenPotted && frame.open) { respot.push('queen'); events.push('Queen returned — colours undecided'); }

  // --- tally the men that left the board ---
  menOff();
  let myPots = 0;
  for (const p of men) {
    if (p.color === myColor) { myPots += 1; frame.scores[me] += 1; }
    else if (p.color === oppColor) { frame.scores[opp] += 1; } // helped the opponent
  }
  if (myPots > 0) events.push(`Player ${me + 1} pots ${myPots}`);

  // --- Queen cover logic ---
  const coverable = queenPotted && !frame.open;
  if (coverable) {
    if (myPots > 0) { frame.queenAwarded = me; frame.scores[me] += 3; events.push(`Player ${me + 1} pockets & covers the Queen (+3)`); }
    else { frame.queenPending = true; frame.queenOwner = me; events.push(`Player ${me + 1} pockets the Queen — must cover it`); }
  } else if (frame.queenPending && frame.queenOwner === me && myPots > 0) {
    frame.queenPending = false; frame.queenOwner = null; frame.queenAwarded = me; frame.scores[me] += 3; events.push('Queen covered (+3)');
  }

  // --- keep striking after potting your own man or the Queen; else pass ---
  const continues = myPots > 0 || (queenPotted && coverable);
  if (!continues) {
    if (frame.queenPending && frame.queenOwner === me) { frame.queenPending = false; frame.queenOwner = null; respot.push('queen'); events.push('Queen returned — not covered'); }
    frame.turn = opp;
    events.push(`Player ${me + 1} — no pot`);
  }
  frame.ballInHand = true;

  // --- win: clear all your men ---
  if (!frame.open && frame.remaining[myColor] === 0) {
    frame.frameOver = true; frame.winner = me;
    events.push(`Player ${me + 1} clears ${myColor} — wins the frame!`);
  }
  frame.message = events.join(' · ');
  return { events, foul: false, continues, respot, message: frame.message };
}

let respotSeq = 0;
function respotPiece(state, color) {
  // return a piece to a free spot spiralling out from the centre
  for (let rad = 0; rad < 0.3; rad += 2 * R) {
    for (let k = 0; k < 14; k++) {
      const a = (k / 14) * Math.PI * 2 + rad;
      const x = Math.cos(a) * rad, y = Math.sin(a) * rad;
      if (clear(state, x, y, null)) return { id: color === 'queen' ? 'queen' : `${color}R${respotSeq++}`, color, kind: 'object', pos: { x, y } };
    }
  }
  return { id: color === 'queen' ? 'queen' : `${color}R${respotSeq++}`, color, kind: 'object', pos: { x: 0, y: 0 } };
}

// --- AI: aim your own men (and the Queen) into a corner from a point on your baseline ---
function aiTargets(state) {
  const f = state.frame;
  const pieces = state.pieces;
  if (f.open) return pieces.filter((p) => p.color === 'white' || p.color === 'black');
  const mine = f.assigned[f.turn];
  const t = pieces.filter((p) => p.color === mine);
  const q = pieces.find((p) => p.color === 'queen');
  if (q && t.length) t.push(q); // go for the Queen too (there's a man to cover with)
  return t;
}
const legalFirst = (frame, piece) => piece != null && piece.id !== 'cue'; // any piece is a legal first contact
function legalPot(frame, piece) {
  if (frame.open) return piece.color === 'white' || piece.color === 'black';
  return piece.color === frame.assigned[frame.turn] || piece.color === 'queen';
}

export const carrom = {
  id: 'carrom',
  name: 'Carrom',
  ball: { radius: BALL.radius, mass: BALL.mass },
  cloth: '#c69a5b', // warm ply-wood tone rather than felt
  cueColor: COLORS.cue,
  rackJitter: 0.0006,
  discPieces: true, // draw the men + striker as flat discs, not balls
  rulesText: [
    'Place the striker on your baseline and flick it at the packed men.',
    'The board is "open" until someone pots a man — that colour is theirs, the opponent gets the other.',
    'Pot one of YOUR men to keep striking; potting the opponent’s man just gives it to them.',
    'Pot the red Queen, then COVER it by potting one of your own men (same or a later stroke) for +3 — or it goes back.',
    'Foul (pot the striker, or hit nothing): turn passes and this stroke’s pots return to the centre.',
    'Clear all your men to win the frame.',
  ],
  bounds,
  pockets,
  rack,
  newFrame,
  applyOutcome,
  respotPiece,

  // --- striker on a baseline: placement is constrained to the current player's line segment ---
  ballInHandLabel: 'Place the striker on your baseline',
  placementLegal(state, x, y) {
    const by = baselineY(state.frame);
    return Math.abs(y - by) < 0.03 && Math.abs(x) <= BLX && clear(state, x, y);
  },
  defaultPlacement(state) {
    const by = baselineY(state.frame);
    for (const x of [0, 0.12, -0.12, 0.22, -0.22, 0.3, -0.3]) if (clear(state, x, by)) return { x, y: by };
    return { x: 0, y: by };
  },

  aiTargets,
  aiLegalFirst: legalFirst,
  aiLegalPot: legalPot,
  aiValue: (frame, piece) => (piece.color === 'queen' ? 140 : 100),
  aiPenalty: (frame, piece) => 120, // potting the opponent's man hands them a piece
  aiPlacements(state) {
    const by = baselineY(state.frame);
    const out = [];
    for (let k = -3; k <= 3; k++) { const x = (k / 3) * BLX * 0.92; if (this.placementLegal(state, x, by)) out.push({ x, y: by }); }
    if (!out.length) out.push(this.defaultPlacement(state));
    return out;
  },

  colorOf: (piece) => COLORS[piece.color] ?? piece.color,
  isStripe: () => false,
  label: () => '',
  // 3D bed markings: the two baselines, the four base-end circles, and the central circle.
  markings: () => ({
    lines: [
      [{ x: -BLX, y: -BY }, { x: BLX, y: -BY }],
      [{ x: -BLX, y: BY }, { x: BLX, y: BY }],
    ],
    arcs: [
      { cx: 0, cy: 0, r: CENTRE_R, a0: 0, a1: Math.PI * 2 },
      { cx: -BLX, cy: -BY, r: 0.018, a0: 0, a1: Math.PI * 2 }, { cx: BLX, cy: -BY, r: 0.018, a0: 0, a1: Math.PI * 2 },
      { cx: -BLX, cy: BY, r: 0.018, a0: 0, a1: Math.PI * 2 }, { cx: BLX, cy: BY, r: 0.018, a0: 0, a1: Math.PI * 2 },
    ],
    spots: [],
  }),

  sideValue(frame, i) {
    if (frame.open || !frame.assigned[i]) return '—';
    const g = frame.assigned[i];
    return `${g} ${frame.remaining[g]}`;
  },
  centerText(frame) {
    if (frame.frameOver) return '';
    if (frame.open) return 'open board';
    if (frame.queenPending && frame.queenOwner === frame.turn) return 'cover the Queen';
    return frame.assigned[frame.turn];
  },
  turnGoal(frame) {
    if (frame.open) return 'flick a man in to claim a colour';
    if (frame.queenPending && frame.queenOwner === frame.turn) return 'pot one of your men to cover the Queen';
    return `pot a ${frame.assigned[frame.turn]} man`;
  },
};
