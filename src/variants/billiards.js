// variants/billiards.js — English Billiards (3 balls, snooker-size table with pockets).
//
// Three balls: the striker's cue (white), the other white (here 'yellow'), and the red. Scoring
// per stroke, cumulative:
//   • cannon (cue hits both other balls) = 2
//   • pot red = 3,  pot the white = 2
//   • in-off (cue potted) off red = 3, off white = 2
// Score keeps you at the table; a non-scoring stroke (or hitting nothing) passes the turn. Red
// and the white are re-spotted when potted; after an in-off you play from the "D". First to the
// target (50) wins.
//
// Simplified: both players strike the same white cue ball (not separate cue balls); no baulk/
// "miss" penalties; position/safety not modelled in the AI.

import { BALL } from '../snooker.js';
import { bounds, pockets, spots, dCentre, inD, HX, HY, baulkX, TABLE } from '../table.js';

const R = BALL.radius;
const CSS = { cue: '#f5f3ea', yellow: '#e7c63b', red: '#c0241f' };
const TARGET = 50;
const playerName = (t) => `Player ${t + 1}`;

const clear = (state, x, y) => state.pieces.every((p) => p.id === 'cue' || Math.hypot(p.pos.x - x, p.pos.y - y) >= 2 * R + 1e-3);
const within = (x, y) => x >= -HX + R && x <= HX - R && y >= -HY + R && y <= HY - R;

function rack() {
  return [
    { id: 'cue', color: 'cue', kind: 'cue', pos: { x: baulkX(), y: -0.15 } },
    { id: 'yellow', color: 'yellow', kind: 'object', pos: { x: baulkX(), y: 0.15 } },
    { id: 'red', color: 'red', kind: 'object', pos: { x: spots().black.x, y: 0 } }, // the billiard spot
  ];
}

function newFrame() {
  return { turn: 0, scores: [0, 0], ballInHand: true, frameOver: false, winner: null, target: TARGET, message: 'Player 1 to break' };
}

// A free spot for a re-spotted ball: its home spot, else search outward toward the top rail.
function freeSpot(state, home) {
  if (within(home.x, home.y) && clear(state, home.x, home.y)) return { ...home };
  for (let rad = 2 * R; rad < 0.4; rad += R)
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      const x = home.x + Math.cos(a) * rad;
      const y = home.y + Math.sin(a) * rad;
      if (within(x, y) && clear(state, x, y)) return { x, y };
    }
  return { ...home };
}

function applyOutcome(frame, info) {
  const { firstContact = null, potted = [], cuePotted = false, cueContacts = [] } = info;
  const me = frame.turn;
  const opp = 1 - me;
  const hit = new Set(cueContacts.map((p) => p.color));
  const pottedRed = potted.some((p) => p.color === 'red');
  const pottedYellow = potted.some((p) => p.color === 'yellow');
  const fc = firstContact ? firstContact.color : null;
  const events = [];
  let pts = 0;

  if (hit.has('red') && hit.has('yellow')) { pts += 2; events.push('Cannon +2'); }
  if (pottedRed) { pts += 3; events.push('Pot red +3'); }
  if (pottedYellow) { pts += 2; events.push('Pot white +2'); }
  if (cuePotted) {
    if (fc === 'red') { pts += 3; events.push('In-off red +3'); }
    else if (fc === 'yellow') { pts += 2; events.push('In-off white +2'); }
  }
  const miss = fc === null;

  const respot = [];
  if (pottedRed) respot.push('red');
  if (pottedYellow) respot.push('yellow');
  if (cuePotted) frame.ballInHand = true; // play the next stroke from the "D"

  frame.scores[me] += pts;
  if (pts > 0) events.push(`${playerName(me)} +${pts} (=${frame.scores[me]})`);
  else events.push(miss ? `${playerName(me)} missed` : `${playerName(me)} — no score`);

  if (frame.scores[me] >= frame.target) {
    frame.frameOver = true;
    frame.winner = me;
    events.push(`${playerName(me)} wins ${frame.scores[me]}–${frame.scores[opp]}`);
    frame.message = events.join(' · ');
    return { events, foul: miss, continues: false, message: frame.message, respot };
  }

  const continues = pts > 0;
  if (!continues) frame.turn = opp;
  frame.message = events.join(' · ');
  return { events, foul: miss, continues, message: frame.message, respot };
}

const home = { red: () => ({ x: spots().black.x, y: 0 }), yellow: () => ({ x: dCentre().x, y: 0 }) };

export const billiards = {
  id: 'billiards',
  name: 'Billiards',
  ball: { radius: BALL.radius, mass: BALL.mass },
  cloth: '#0e6b3d',
  cueColor: 'cue',
  rulesText: [
    'Score per stroke (cumulative): cannon (cue hits both balls) = 2, pot red = 3, pot the white = 2.',
    'In-off (the cue ball is potted) = 3 off the red, 2 off the white.',
    'Any score keeps you at the table; a non-scoring stroke passes the turn.',
    'Red and the white are re-spotted when potted; after an in-off, play from the "D".',
    'First to 50 points wins.',
  ],
  bounds,
  pockets,
  rack,
  newFrame,
  applyOutcome,
  respotPiece(state, color) {
    return { id: color, color, kind: 'object', pos: freeSpot(state, home[color]()) };
  },

  ballInHandLabel: 'Play from the "D"',
  placementLegal: (state, x, y) => inD(x, y, R) && clear(state, x, y),
  defaultPlacement(state) {
    const desired = { x: baulkX(), y: -0.2 };
    if (inD(desired.x, desired.y, R) && clear(state, desired.x, desired.y)) return desired;
    for (let rad = 2 * R; rad < 0.3; rad += R)
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        const x = desired.x + Math.cos(a) * rad;
        const y = desired.y + Math.sin(a) * rad;
        if (inD(x, y, R) && clear(state, x, y)) return { x, y };
      }
    return desired;
  },

  aiTargets: (state) => state.pieces.filter((p) => p.kind === 'object'),
  aiLegalFirst: (frame, piece) => piece != null,
  aiLegalPot: () => true,
  aiValue: (frame, piece) => (piece.color === 'red' ? 300 : 200),
  aiScore(state, res, pieceById) {
    const hit = new Set(res.cueContacts.map((id) => pieceById.get(id)?.color));
    const potted = res.pocketed.filter((id) => id !== 'cue').map((id) => pieceById.get(id)?.color);
    const cuePotted = res.pocketed.includes('cue');
    const fc = res.firstContact ? pieceById.get(res.firstContact).color : null;
    let pts = 0;
    if (hit.has('red') && hit.has('yellow')) pts += 2;
    if (potted.includes('red')) pts += 3;
    if (potted.includes('yellow')) pts += 2;
    if (cuePotted) pts += fc === 'red' ? 3 : fc === 'yellow' ? 2 : 0;
    return pts * 100 + (fc === null ? -200 : 0) - (cuePotted && pts === 0 ? 100 : 0);
  },
  aiPlacements(state) {
    const d = dCentre();
    const trySpots = [{ x: d.x, y: 0.12 }, { x: d.x, y: -0.12 }, { x: d.x, y: 0.2 }, { x: d.x, y: -0.2 }, { x: d.x - 0.1, y: 0 }];
    return trySpots.filter((p) => inD(p.x, p.y, R) && clear(state, p.x, p.y));
  },

  colorOf: (piece) => CSS[piece.color] ?? piece.color,
  isStripe: () => false,
  label: () => '',
  drawMarkings(ctx, h) {
    const bx = baulkX();
    ctx.strokeStyle = 'rgba(230,230,230,0.5)';
    ctx.lineWidth = 1.2;
    const a = h.toPx(bx, HY);
    const b = h.toPx(bx, -HY);
    ctx.beginPath(); ctx.moveTo(a.px, a.py); ctx.lineTo(b.px, b.py); ctx.stroke();
    const dc = h.toPx(dCentre().x, dCentre().y);
    ctx.beginPath(); ctx.arc(dc.px, dc.py, h.sPx(TABLE.dRadius), Math.PI / 2, (3 * Math.PI) / 2); ctx.stroke();
    ctx.fillStyle = 'rgba(230,230,230,0.55)';
    for (const s of [home.red(), home.yellow()]) {
      const p = h.toPx(s.x, s.y);
      ctx.beginPath(); ctx.arc(p.px, p.py, 2, 0, Math.PI * 2); ctx.fill();
    }
  },

  sideValue: (frame, i) => String(frame.scores[i]),
  centerText: (frame) => (frame.frameOver ? '' : `to ${frame.target}`),
};
