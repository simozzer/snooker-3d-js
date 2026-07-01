// variants/snooker.js — the snooker game as a "variant": geometry, rack, rules, AI targeting
// and rendering, behind the common interface that game.js / ai.js / the renderer consume. It
// wraps the existing snooker modules (table.js, rack.js, rules.js) so they stay unit-tested.

import * as v from '../vec2.js';
import { BALL, MAX_SPEED } from '../snooker.js';
import { bounds, pockets, spots, dCentre, inD, HX, HY, baulkX, TABLE } from '../table.js';
import { openingPieces } from '../rack.js';
import { newFrame, applyOutcome as rulesApply, ballOn, VALUES, COLOUR_ORDER } from '../rules.js';

const COLORS = {
  cue: '#f5f3ea', red: '#c0241f', yellow: '#e7c63b', green: '#1f7a43',
  brown: '#7a4a24', blue: '#2156b0', pink: '#e58fa6', black: '#1a1a1a',
};
const R = BALL.radius;

const clear = (state, x, y) =>
  inD(x, y, R) && state.pieces.every((p) => p.id === 'cue' || Math.hypot(p.pos.x - x, p.pos.y - y) >= 2 * R + 1e-3);

const isLegalPot = (on, color) => (on === 'red' ? color === 'red' : on === 'any-colour' ? color !== 'red' : color === on);

export const snooker = {
  id: 'snooker',
  name: 'Snooker',
  redCount: 15, // reds in the opening rack (Double Snooker overrides this to 30)
  ball: { radius: BALL.radius, mass: BALL.mass },
  cloth: '#0e6b3d',
  cueColor: 'cue',
  rulesText: [
    'Pot a red (1 pt), then a colour (yellow 2 … black 7); the colour is re-spotted. Repeat until the reds are gone.',
    'Then clear the six colours in ascending order — these stay down once potted.',
    'Foul (wrong or no first contact, or potting the cue ball): the opponent scores 4–7.',
    'When all balls are gone, the higher score wins the frame.',
  ],
  bounds,
  pockets,
  rack: openingPieces,
  newFrame,

  // --- rules adapter: pieces → colour strings, then the pure snooker rule core ---
  applyOutcome(frame, info) {
    return rulesApply(frame, {
      firstContact: info.firstContact ? info.firstContact.color : null,
      potted: info.potted.map((p) => p.color),
      cuePotted: info.cuePotted,
    });
  },
  // a re-spotted colour → a piece placed on a free spot
  respotPiece(state, color) {
    return { id: color, color, kind: 'colour', pos: freeSpot(state, color) };
  },

  // --- ball-in-hand (the "D") ---
  ballInHandLabel: 'Place the cue ball in the "D"',
  placementLegal: (state, x, y) => clear(state, x, y),
  defaultPlacement(state) {
    const desired = { x: baulkX(), y: 0.2 };
    if (clear(state, desired.x, desired.y)) return desired;
    for (let rad = 2 * R; rad < 0.3; rad += R)
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        const x = desired.x + Math.cos(a) * rad;
        const y = desired.y + Math.sin(a) * rad;
        if (clear(state, x, y)) return { x, y };
      }
    return desired;
  },

  // --- AI targeting ---
  aiTargets(state) {
    const on = ballOn(state.frame);
    if (on === 'red') return state.pieces.filter((p) => p.color === 'red');
    if (on === 'any-colour') return state.pieces.filter((p) => p.kind === 'colour');
    return state.pieces.filter((p) => p.color === on);
  },
  aiLegalFirst(frame, piece) {
    return piece != null && isLegalPot(ballOn(frame), piece.color);
  },
  aiLegalPot(frame, piece) {
    return isLegalPot(ballOn(frame), piece.color);
  },
  aiValue: (frame, piece) => VALUES[piece.color] * 100,
  // Weight the AI's positional leave by ball value (the black off every red) — snooker-only;
  // see bestNextPotProb in ai.js. Other variants leave this unset and keep ease-only leaves.
  playForValue: true,
  // Break-building (snooker-only): potting >1 red in a single stroke forfeits a black — you only
  // get ONE colour after potting reds, so two reds at once share a single black and you lose ~7
  // points of break (and any chance of a 147). Damp each extra red so the AI prefers to pot reds
  // one at a time and leave the rest on the table. The damp (1.5× a red) only flips the
  // preference — a forced multi-red (the only scoring shot) still nets positive, so it's taken.
  aiPottedAdjust(frame, potted) {
    if (ballOn(frame) !== 'red') return 0; // only relevant while reds are the ball-on
    const extraReds = potted.filter((p) => p && p.color === 'red').length - 1;
    return extraReds > 0 ? -extraReds * 1.5 * VALUES.red * 100 : 0;
  },
  // Safety play (snooker-only): when no pot is on, the AI scores a legal miss by how hard it leaves
  // the OPPONENT (see positionBonus in ai.js) — leaving them snookered/awkward instead of an easy
  // pot. Other variants leave this unset and keep their roll-to-nearest-target fallback.
  safetyPlay: true,
  // 2-ply look-ahead (snooker-only): refine the top red-pot lines by whether the leave on the black
  // also recovers a red after the black — keeps the 147 cycle alive. See cycleBonus in ai.js.
  lookahead2: true,
  // Opening-break shots (snooker-only). The AI picks a STYLE at random each frame (see chooseShot)
  // and this returns a pool of candidate shots for it; the engine then picks the best one:
  //   'safe'      — thin clip on a back-corner red, firm pace so the cue returns toward baulk and
  //                 the pack stays intact (the realistic, defensive break).
  //   'attacking' — drive fully into the apex of the pack with pace to spread the reds wide open.
  //   'firm'      — a clean medium-pace strike into the front of the pack; a positive middle ground.
  // Returns [] when it isn't the opening break (full rack + ball-in-hand).
  aiBreakShots(state, style = 'safe') {
    const f = state.frame;
    const full = this.redCount; // 15 (snooker) or 30 (double snooker)
    if (!(f.reds === full && f.ballInHand && COLOUR_ORDER.every((c) => f.colours[c]))) return [];
    const reds = state.pieces.filter((p) => p.color === 'red');
    if (reds.length < full) return [];
    const places = this.aiPlacements(state);
    if (!places.length) return [];
    const R = BALL.radius;
    // Only the back-corner reds are reachable from the D — a straight line at the apex is blocked by
    // the brown/blue/pink sitting on their spots down the spine of the table. So every style clips a
    // corner red; the STYLE is the contact thickness (k, outward offset in ball-diameters) and pace:
    //   safe = thin clip + modest pace (cue rebounds to baulk, pack intact);
    //   attacking = near-full contact + max pace (drive the corner red into the pack to spread it);
    //   firm = medium contact + medium pace.
    const maxX = Math.max(...reds.map((r) => r.pos.x));
    const back = reds.filter((r) => r.pos.x > maxX - R); // back row
    const top = back.reduce((a, b) => (b.pos.y > a.pos.y ? b : a));
    const bot = back.reduce((a, b) => (b.pos.y < a.pos.y ? b : a));
    const aim = (c, tx, ty) => Math.atan2(ty - c.y, tx - c.x);
    const cfg = {
      safe: { ks: [0.55, 0.75, 0.95], sps: [0.45, 0.55, 0.65], vert: 0 },
      attacking: { ks: [0.05, 0.2, 0.35], sps: [0.85, 1.0], vert: 0.3 },
      firm: { ks: [0.25, 0.45, 0.65], sps: [0.6, 0.72], vert: 0 },
    }[style];
    if (!cfg) return [];
    const out = [];
    for (const corner of [top, bot]) {
      const outward = Math.sign(corner.pos.y) || 1;
      for (const c of places) for (const k of cfg.ks) {
        const angle = aim(c, corner.pos.x, corner.pos.y + outward * 2 * R * k);
        for (const sp of cfg.sps) out.push({ cuePos: { ...c }, angle, speed: MAX_SPEED * sp, spin: { side: 0, vert: cfg.vert } });
      }
    }
    return out;
  },
  aiWinBonus: () => 0,
  aiPlacements(state) {
    const d = dCentre();
    const spotsList = [
      { x: d.x, y: 0.12 }, { x: d.x, y: -0.12 }, { x: d.x, y: 0.2 }, { x: d.x, y: -0.2 },
      { x: d.x - 0.12, y: 0.1 }, { x: d.x - 0.12, y: -0.1 },
    ];
    return spotsList.filter((p) => clear(state, p.x, p.y));
  },

  // --- rendering ---
  colorOf: (piece) => COLORS[piece.color] ?? piece.color,
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
    for (const s of Object.values(spots())) {
      const p = h.toPx(s.x, s.y);
      ctx.beginPath(); ctx.arc(p.px, p.py, 2, 0, Math.PI * 2); ctx.fill();
    }
  },

  // --- HUD ---
  sideValue: (frame, i) => String(frame.scores[i]),
  centerText: (frame) => (frame.frameOver ? '' : `on: ${ballOn(frame) ?? '—'}`),
};

// Free spot for a re-spotted colour: its own spot, else the higher-value spots, else step back
// along the centre line. (Snooker re-spot, simplified — needs table geometry, hence here.)
function freeSpot(state, color) {
  const s = spots();
  const occupied = (x, y) => state.pieces.some((p) => (p.pos.x - x) ** 2 + (p.pos.y - y) ** 2 < (2 * R) ** 2 * 0.999);
  const within = (x, y) => x >= -HX + R && x <= HX - R && y >= -HY + R && y <= HY - R;
  for (const name of [color, 'black', 'pink', 'blue', 'brown', 'green', 'yellow']) {
    const sp = s[name];
    if (within(sp.x, sp.y) && !occupied(sp.x, sp.y)) return { x: sp.x, y: sp.y };
  }
  let x = s[color].x;
  while (x < HX - R) {
    x += 2 * R;
    if (within(x, 0) && !occupied(x, 0)) return { x, y: 0 };
  }
  return { x: s[color].x, y: s[color].y };
}
