// backgammon-view.js — the Canvas 2D VIEW + input controller for backgammon. It owns the board
// drawing, the dice, pointer/touch input and the AI loop, and drives the DOM-free engine in
// src/board/backgammon.js through the small mount(ctx) contract shared by all the board games.
//
// Layout note: backgammon is a WIDE board, so unlike chess/draughts we call fitCanvas with
// {square:false} and lay a ~1.35:1 board out centred inside the available box. White is the human in
// 'ai' mode: white's home is the bottom-right quadrant; white bears off down the right-hand tray.

import { createBackgammon } from '../../src/board/backgammon.js';
import { THEME, fitCanvas, pointerXY, roundRect, animate, easeOut, think } from './board-common.js';

// Colours for the felt, points and checkers — tuned to sit inside the compendium's dark palette.
const FELT = '#0f3d2e';        // deep green playing field
const FELT_EDGE = '#0b2a20';
const FRAME = '#3a2417';       // wood surround
const FRAME_HI = '#5a3a24';
const BAR_COL = '#2a1710';
const PT_LIGHT = '#c9a06a';    // alternating point colours
const PT_DARK = '#7c4a24';
const CHK_W = '#efe6d2';       // white = warm ivory
const CHK_W_EDGE = '#c9bca0';
const CHK_B = '#2b333b';       // black = dark slate
const CHK_B_EDGE = '#151b21';
const LABEL = '#e8e8e8';

// Online seat ↔ colour: seat 0 (the room creator) is White and rolls first, matching the relay's
// turn-0-first rule and the engine's white-to-start. Seat 1 is Black.
const COLOUR_FOR_SEAT = ['w', 'b'];
const seatForColour = (c) => (c === 'w' ? 0 : 1);

// Derive two dice (1..6) from the relay's ONE authoritative uint32 so BOTH clients roll the identical
// pair — the whole reason the relay owns randomness. Modulo-6 bias on a 32-bit value is negligible for
// dice. Exported so the online tests derive rolls exactly as the view does (single source of truth).
export function diceFromU32(v) {
  const u = v >>> 0;
  return [(u % 6) + 1, (Math.floor(u / 6) % 6) + 1];
}

export default function mount(ctx) {
  const { canvas, box, gameControls, ui } = ctx;
  const engine = createBackgammon();

  // ---- view/controller state ----
  let mode = ctx.getMode();          // 'ai' | 'human'
  let difficulty = ctx.getDifficulty();
  const HUMAN = 'w';                 // in 'ai' mode the human is always white (bottom)
  let selected = null;               // selected source: 'bar' | point index | null
  let legalTargets = [];             // cached legal moves from `selected`
  let over = false;
  let busy = false;                  // true while the AI is animating (blocks input)
  let stopAnim = null;               // active animation canceller
  let lastMove = null;               // {from,to} for a subtle highlight
  let anim = null;                   // {from,to,color,t} sliding checker overlay
  let onlineSeat = -1;               // our seat (0/1) in an online game, or -1 when offline
  let gameOverSent = false;          // report a finished online game to the relay only once

  // Online helpers. isOnline() gates every AI/local-only path; myColour()/otherSeat() map our seat.
  const isOnline = () => onlineSeat >= 0 && !!ctx.net?.isOnline();
  const myColour = () => COLOUR_FOR_SEAT[onlineSeat];
  const otherSeat = () => (onlineSeat === 0 ? 1 : 0);

  // Geometry is recomputed on every resize into this object.
  let geo = null;

  // ---- board geometry -------------------------------------------------------------------------
  // We build a lookup from point index -> the on-screen "slot" (base x/y of the stack + direction the
  // stack grows). Points 0..23 are laid out in the classic two rows of twelve with the bar splitting
  // each row into quadrants. White's home (0..5) sits bottom-right; the numbering wraps as on a real
  // board so white travels anticlockwise toward its home.
  function layout() {
    const { w, h } = fitCanvas(canvas, box, { square: false });
    // Fit a 1.35:1 board centred in the box with a margin.
    const margin = Math.round(Math.min(w, h) * 0.04) + 6;
    const availW = w - margin * 2;
    const availH = h - margin * 2;
    let bw = availW, bh = bw / 1.35;
    if (bh > availH) { bh = availH; bw = bh * 1.35; }
    const bx = Math.round((w - bw) / 2);
    const by = Math.round((h - bh) / 2);

    const frame = Math.max(10, Math.round(bw * 0.028));   // wood border thickness
    const barW = Math.max(20, Math.round(bw * 0.055));     // central bar width
    const trayW = Math.max(22, Math.round(bw * 0.06));     // bear-off tray width (right edge)
    const innerX = bx + frame;
    const innerY = by + frame;
    const innerH = bh - frame * 2;
    // playing field width excludes the right tray
    const fieldW = bw - frame * 2 - trayW;
    const halfW = (fieldW - barW) / 2;                     // width of one 6-point quadrant
    const ptW = halfW / 6;
    const ptH = innerH * 0.42;                             // triangle height
    const chkR = Math.min(ptW * 0.42, innerH * 0.5 / 6);   // checker radius (fit ~5 without labels)
    const rowTopY = innerY;                                // top row baseline (triangles point down)
    const rowBotY = innerY + innerH;                       // bottom row baseline (triangles point up)

    // x-centre of the k-th column (0..11) measured left→right across both quadrants.
    const colCenterX = (k) => {
      const leftBlock = k < 6 ? k : k;
      if (k < 6) return innerX + ptW * (k + 0.5);
      return innerX + halfW + barW + ptW * (k - 6 + 0.5);
    };

    // Map point index -> {colX, baseY, dir(+1 grows down / -1 grows up), top:boolean}.
    // Bottom-right quadrant = white home (indices 0..5), running right→left (0 at far right).
    // Bottom-left quadrant = indices 6..11 (right→left). Top-left = 12..17 (left→right).
    // Top-right = 18..23 (left→right). This is the standard board wrap.
    const slots = new Array(24);
    for (let i = 0; i < 24; i++) {
      let col, top;
      if (i <= 5) { col = 11 - i; top = false; }          // bottom-right: index0 -> col11
      else if (i <= 11) { col = 11 - i; top = false; }     // bottom-left:  index6 -> col5 ... 11->col0
      else if (i <= 17) { col = i - 12; top = true; }      // top-left:     index12 -> col0
      else { col = i - 12; top = true; }                   // top-right:    index18 -> col6
      slots[i] = {
        x: colCenterX(col),
        baseY: top ? rowTopY : rowBotY,
        dir: top ? 1 : -1,
        top,
        col,
      };
    }

    geo = {
      w, h, bx, by, bw, bh, frame, barW, trayW, innerX, innerY, innerH,
      fieldW, halfW, ptW, ptH, chkR, rowTopY, rowBotY,
      barCenterX: innerX + halfW + barW / 2,
      trayX: bx + bw - frame - trayW, trayW2: trayW,
      slots,
      // Bear-off tray split: white collects in the bottom half, black in the top half.
      trayTop: innerY, trayMidY: innerY + innerH / 2, trayBot: innerY + innerH,
    };
    return geo;
  }

  // Where the n-th checker (0-based) on a point/bar/tray sits, given a slot.
  function stackXY(slot, n) {
    const step = geo.chkR * 1.75;
    const maxShown = 5;
    const idx = Math.min(n, maxShown - 1);
    return { x: slot.x, y: slot.baseY + slot.dir * (geo.chkR + idx * step) };
  }

  // ---- drawing --------------------------------------------------------------------------------
  function draw() {
    const g = geo;
    const c = canvas.getContext('2d');
    c.clearRect(0, 0, g.w, g.h);
    c.fillStyle = THEME.bg;
    c.fillRect(0, 0, g.w, g.h);

    // Wood frame + felt field.
    roundRect(c, g.bx, g.by, g.bw, g.bh, g.frame * 0.7);
    c.fillStyle = FRAME; c.fill();
    roundRect(c, g.bx + 3, g.by + 3, g.bw - 6, g.bh - 6, g.frame * 0.5);
    c.strokeStyle = FRAME_HI; c.lineWidth = 1.5; c.stroke();
    c.fillStyle = FELT;
    c.fillRect(g.innerX, g.innerY, g.fieldW, g.innerH);
    c.fillStyle = FELT_EDGE;
    c.fillRect(g.innerX, g.innerY, g.fieldW, 2);

    // 24 triangular points.
    const st = engine.state();
    for (let i = 0; i < 24; i++) {
      const s = g.slots[i];
      const dark = (s.col + (s.top ? 0 : 1)) % 2 === 0;
      drawPoint(c, s, dark ? PT_DARK : PT_LIGHT);
    }

    // Central bar.
    c.fillStyle = BAR_COL;
    c.fillRect(g.innerX + g.halfW, g.innerY, g.barW, g.innerH);
    c.fillStyle = FRAME_HI;
    c.fillRect(g.innerX + g.halfW, g.innerY, 1, g.innerH);
    c.fillRect(g.innerX + g.halfW + g.barW - 1, g.innerY, 1, g.innerH);

    // Bear-off tray.
    c.fillStyle = BAR_COL;
    c.fillRect(g.trayX, g.innerY, g.trayW2, g.innerH);

    // Highlight legal targets (drawn under the checkers so discs stay crisp).
    if (selected !== null) {
      highlightSlot(c, selected === 'bar' ? barSlot(HUMAN_SIDE()) : g.slots[selected], THEME.selected);
      for (const m of legalTargets) {
        if (m.to === 'off') highlightTray(c, engine.turn(), THEME.legal);
        else highlightSlot(c, g.slots[m.to], THEME.legal);
      }
    }

    // Checkers on the 24 points.
    for (let i = 0; i < 24; i++) {
      const p = st.points[i];
      if (!p.count) continue;
      if (anim && anim.from === i) continue; // the moving checker is drawn by the overlay
      drawStack(c, g.slots[i], p.color, p.count, i === (lastMove && lastMove.to));
    }

    // Bar checkers.
    drawBar(c, 'w', st.bar.w);
    drawBar(c, 'b', st.bar.b);

    // Borne-off checkers in the tray (as short flat stacks).
    drawTray(c, 'w', st.off.w);
    drawTray(c, 'b', st.off.b);

    // Sliding-checker animation overlay.
    if (anim) {
      const from = anim.from === 'bar' ? barSlot(anim.color) : g.slots[anim.from];
      const to = anim.to === 'off' ? traySlot(anim.color) : g.slots[anim.to];
      const a = stackXY(from, anim.fromN);
      const b = anim.to === 'off' ? to : stackXY(to, anim.toN);
      const t = easeOut(anim.t);
      drawChecker(c, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, anim.color);
    }

    // Dice for the active player.
    drawDice(c, st);

    // Pip counts (small, unobtrusive).
    drawPips(c);
  }

  function drawPoint(c, s, col) {
    const g = geo;
    const halfW = g.ptW * 0.5;
    c.beginPath();
    c.moveTo(s.x - halfW, s.baseY);
    c.lineTo(s.x + halfW, s.baseY);
    c.lineTo(s.x, s.baseY + s.dir * g.ptH);
    c.closePath();
    c.fillStyle = col;
    c.fill();
    c.strokeStyle = 'rgba(0,0,0,0.25)';
    c.lineWidth = 1;
    c.stroke();
  }

  function drawChecker(c, x, y, color) {
    const r = geo.chkR;
    c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2);
    const grad = c.createRadialGradient(x - r * 0.35, y - r * 0.35, r * 0.2, x, y, r);
    if (color === 'w') { grad.addColorStop(0, '#ffffff'); grad.addColorStop(1, CHK_W); }
    else { grad.addColorStop(0, '#454f59'); grad.addColorStop(1, CHK_B); }
    c.fillStyle = grad; c.fill();
    c.lineWidth = 1.5;
    c.strokeStyle = color === 'w' ? CHK_W_EDGE : CHK_B_EDGE;
    c.stroke();
    c.beginPath(); c.arc(x, y, r * 0.55, 0, Math.PI * 2);
    c.strokeStyle = color === 'w' ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.06)';
    c.stroke();
  }

  function drawStack(c, slot, color, count, isLast) {
    const shown = Math.min(count, 5);
    for (let n = 0; n < shown; n++) {
      const { x, y } = stackXY(slot, n);
      drawChecker(c, x, y, color);
    }
    if (count > 5) {
      const { x, y } = stackXY(slot, shown - 1);
      c.fillStyle = color === 'w' ? '#2b333b' : '#efe6d2';
      c.font = `bold ${Math.round(geo.chkR * 0.95)}px system-ui, sans-serif`;
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(String(count), x, y);
    }
    if (isLast) {
      const { x, y } = stackXY(slot, 0);
      c.beginPath(); c.arc(x, y, geo.chkR + 2, 0, Math.PI * 2);
      c.strokeStyle = THEME.lastMove; c.lineWidth = 3; c.stroke();
    }
  }

  function highlightSlot(c, slot, col) {
    const g = geo;
    c.save();
    c.beginPath();
    const halfW = g.ptW * 0.5;
    c.moveTo(slot.x - halfW, slot.baseY);
    c.lineTo(slot.x + halfW, slot.baseY);
    c.lineTo(slot.x, slot.baseY + slot.dir * g.ptH);
    c.closePath();
    c.fillStyle = col; c.fill();
    c.restore();
  }

  function highlightTray(c, color, col) {
    const g = geo;
    const y = color === 'w' ? g.trayMidY : g.trayTop;
    c.fillStyle = col;
    c.fillRect(g.trayX, y, g.trayW2, g.innerH / 2);
  }

  // A "slot" for the bar so bar checkers stack from the centre outward.
  function barSlot(color) {
    const g = geo;
    return color === 'w'
      ? { x: g.barCenterX, baseY: g.innerY + g.innerH - g.chkR, dir: -1, top: false }
      : { x: g.barCenterX, baseY: g.innerY + g.chkR, dir: 1, top: true };
  }
  function drawBar(c, color, count) {
    if (!count) return;
    const slot = barSlot(color);
    for (let n = 0; n < Math.min(count, 5); n++) {
      const { x, y } = stackXY(slot, n);
      drawChecker(c, x, y, color);
    }
    if (count > 5) {
      const { x, y } = stackXY(slot, 4);
      c.fillStyle = color === 'w' ? '#2b333b' : '#efe6d2';
      c.font = `bold ${Math.round(geo.chkR * 0.9)}px system-ui, sans-serif`;
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(String(count), x, y);
    }
  }

  function traySlot(color) {
    const g = geo;
    return color === 'w'
      ? { x: g.trayX + g.trayW2 / 2, baseY: g.trayBot - geo.chkR, dir: -1 }
      : { x: g.trayX + g.trayW2 / 2, baseY: g.trayTop + geo.chkR, dir: 1 };
  }
  function drawTray(c, color, count) {
    const g = geo;
    const x = g.trayX + g.trayW2 / 2;
    const step = Math.max(4, g.chkR * 0.5);
    for (let n = 0; n < count; n++) {
      const y = color === 'w' ? g.trayBot - g.chkR - n * step : g.trayTop + g.chkR + n * step;
      // Draw as thin borne-off bricks.
      c.fillStyle = color === 'w' ? CHK_W : CHK_B;
      roundRect(c, x - g.chkR * 0.85, y - step * 0.42, g.chkR * 1.7, step * 0.84, 2);
      c.fill();
      c.strokeStyle = color === 'w' ? CHK_W_EDGE : CHK_B_EDGE; c.lineWidth = 1; c.stroke();
    }
  }

  // Dice faces on the active half of the board; used dice are dimmed.
  function drawDice(c, st) {
    if (!st.rolled || !st.dice.length) return;
    const g = geo;
    const active = st.turn;
    // Pick a clear spot on the mover's side of the board.
    const onLeft = active === 'w';   // white sits bottom; draw dice on the left field for both
    const size = Math.max(20, Math.round(g.ptW * 0.9));
    const gap = size * 0.35;
    const n = st.dice.length;
    const totalW = n * size + (n - 1) * gap;
    const cx = g.innerX + g.halfW / 2 - totalW / 2;
    const cy = g.innerY + g.innerH / 2 - size / 2;

    // Determine which dice are "used": consume movesLeft against the dice list.
    const remaining = st.movesLeft.slice();
    const used = st.dice.map((d) => {
      const i = remaining.indexOf(d);
      if (i >= 0) { remaining.splice(i, 1); return false; }
      return true;
    });

    for (let i = 0; i < n; i++) {
      drawDie(c, cx + i * (size + gap), cy, size, st.dice[i], used[i], active);
    }
  }

  function drawDie(c, x, y, s, val, dim, color) {
    roundRect(c, x, y, s, s, s * 0.18);
    c.fillStyle = dim ? (color === 'w' ? '#8a8478' : '#3a4048') : (color === 'w' ? '#f4efe4' : '#31383f');
    c.globalAlpha = dim ? 0.45 : 1;
    c.fill();
    c.strokeStyle = 'rgba(0,0,0,0.4)'; c.lineWidth = 1.5; c.stroke();
    const pip = s * 0.11;
    const dot = color === 'w' ? '#2b2620' : '#e8e8e8';
    const P = { c: [0.5, 0.5], tl: [0.28, 0.28], tr: [0.72, 0.28], bl: [0.28, 0.72], br: [0.72, 0.72], ml: [0.28, 0.5], mr: [0.72, 0.5] };
    const faces = {
      1: ['c'], 2: ['tl', 'br'], 3: ['tl', 'c', 'br'], 4: ['tl', 'tr', 'bl', 'br'],
      5: ['tl', 'tr', 'c', 'bl', 'br'], 6: ['tl', 'tr', 'ml', 'mr', 'bl', 'br'],
    };
    c.fillStyle = dot;
    for (const k of faces[val] || []) {
      const [px, py] = P[k];
      c.beginPath(); c.arc(x + px * s, y + py * s, pip, 0, Math.PI * 2); c.fill();
    }
    c.globalAlpha = 1;
  }

  function drawPips(c) {
    const g = geo;
    c.font = `${Math.max(10, Math.round(g.frame * 0.7))}px system-ui, sans-serif`;
    c.textBaseline = 'middle';
    c.fillStyle = THEME.muted;
    c.textAlign = 'left';
    c.fillText(`● ${engine.pip('b')}`, g.bx + 6, g.by + g.frame / 2);          // black pip top-left
    c.textAlign = 'right';
    c.fillText(`○ ${engine.pip('w')}`, g.bx + g.bw - 6, g.by + g.bh - g.frame / 2); // white pip bottom-right
  }

  // Which side the human currently controls (for bar-slot highlight when selecting the bar).
  function HUMAN_SIDE() { return engine.turn(); }

  // ---- hit-testing ----------------------------------------------------------------------------
  function hitTest(x, y) {
    const g = geo;
    // Bar first (when the current player has checkers there).
    const st = engine.state();
    const turn = engine.turn();
    if (st.bar[turn] > 0) {
      if (x > g.innerX + g.halfW && x < g.innerX + g.halfW + g.barW) return 'bar';
    }
    // Bear-off tray.
    if (x >= g.trayX && x <= g.trayX + g.trayW2) return 'off';
    // Points: pick the column whose triangle contains (or is nearest below/above) the pointer.
    for (let i = 0; i < 24; i++) {
      const s = g.slots[i];
      if (Math.abs(x - s.x) > g.ptW * 0.5) continue;
      // Accept a click anywhere in that column's half of the board.
      if (s.top && y < g.innerY + g.innerH / 2) return i;
      if (!s.top && y >= g.innerY + g.innerH / 2) return i;
    }
    return null;
  }

  // ---- turn / flow ----------------------------------------------------------------------------
  function refreshUI() {
    const st = engine.state();
    const turn = st.turn;
    const status = engine.status();
    if (status.over) {
      over = true;
      ui.result(status.winner === 'w' ? 'White wins' : 'Black wins');
      ui.turn(null);
      ui.status(status.reason);
      rollBtn.disabled = true;
      ui.setUndo(false);
      if (isOnline() && !gameOverSent) { // tally once; both clients report, the relay dedupes per room
        gameOverSent = true;
        ctx.net.sendGameOver(seatForColour(status.winner)); // backgammon always has a winner (no draws)
      }
      return;
    }
    ui.result(null);
    const who = turn === 'w' ? 'White' : 'Black';

    if (isOnline()) {
      if (!ctx.net.isReady()) { ui.turn('Waiting for opponent…'); ui.status(`You are ${myColour() === 'w' ? 'White' : 'Black'}.`); rollBtn.disabled = true; ui.setUndo(false); return; }
      const mine = turn === myColour();
      if (mine) ui.turn(st.rolled ? `Your move — ${who}` : `Your roll — ${who}`);
      else ui.turn(st.rolled ? `Opponent moving — ${who}` : `Opponent to roll — ${who}`);
      rollBtn.disabled = !mine || st.rolled || busy;
      ui.setUndo(false); // no unilateral take-backs online
      return;
    }

    const humanTurn = mode === 'human' || turn === HUMAN;
    const aiTurn = mode === 'ai' && turn !== HUMAN;

    if (aiTurn) {
      ui.turn(`${who} (AI) to play`);
    } else if (!st.rolled) {
      ui.turn(`${who} — roll the dice`);
    } else {
      ui.turn(`${who} — move your checkers`);
    }

    // Roll button: enabled only when it's a human's turn and they haven't rolled.
    rollBtn.disabled = busy || over || aiTurn || st.rolled;
    // Undo: only within a human turn with a move already made.
    ui.setUndo(humanTurn && st.rolled && engine.state().movesLeft.length < st.dice.length && !busy);
  }

  // Roll for the current (human) player, then either prompt to move or auto-pass.
  function doRoll() {
    if (busy || over) return;
    const st = engine.state();
    if (st.rolled) return;
    if (isOnline()) {
      // Don't roll locally: ask the relay for ONE authoritative value that both clients consume via
      // applyRemoteRandom. Guard so only the turn-holder rolls, and only once.
      if (!ctx.net.isReady() || engine.turn() !== myColour()) return;
      rollBtn.disabled = true;
      ctx.net.requestRandom();
      return;
    }
    const r = engine.roll();
    selected = null; legalTargets = [];
    if (!r.canMove) {
      ui.status(`${st.turn === 'w' ? 'White' : 'Black'} rolled ${r.d1}-${r.d2} — no legal move, passing.`);
      draw();
      setTimeout(() => { engine.endTurn(); afterTurnChange(); }, 900);
      return;
    }
    ui.status(`Rolled ${r.dice.join('-')}. ${autoPromptNoMoves() ? '' : 'Select a checker.'}`);
    draw();
    refreshUI();
  }

  function autoPromptNoMoves() { return false; }

  // After a move (human or AI step), settle the state: end the turn if no moves remain, detect wins.
  function settleAfterMove() {
    if (engine.status().over) { draw(); refreshUI(); return; }
    if (engine.state().movesLeft.length === 0 || !engine.canMove()) {
      // Turn is complete — pass to the opponent.
      selected = null; legalTargets = [];
      engine.endTurn();
      afterTurnChange();
    } else {
      draw(); refreshUI();
    }
  }

  // Called whenever the turn passes to a new player: kick off the AI if it's their move.
  function afterTurnChange() {
    selected = null; legalTargets = [];
    draw();
    refreshUI();
    maybeRunAI();
  }

  function maybeRunAI() {
    if (over || isOnline()) return; // online play never runs a local AI — the opponent is a real peer
    const turn = engine.turn();
    if (!(mode === 'ai' && turn !== HUMAN)) return;
    busy = true;
    refreshUI();
    ui.turn('AI is rolling…');
    // Small beat so the human sees the hand-over, then roll + think.
    setTimeout(() => {
      const r = engine.roll();
      draw();
      if (!r.canMove) {
        ui.status(`AI rolled ${r.d1}-${r.d2} — no legal move.`);
        setTimeout(() => { busy = false; engine.endTurn(); afterTurnChange(); }, 800);
        return;
      }
      ui.turn('AI is thinking…');
      think(() => engine.aiTurn(difficulty), (seq) => runAISequence(seq));
    }, 420);
  }

  // Apply an AI move-sequence one checker at a time with a slide animation.
  function runAISequence(seq) {
    let k = 0;
    const stepNext = () => {
      if (k >= seq.length) {
        busy = false;
        settleAfterMove();
        return;
      }
      const mv = seq[k++];
      animateMove(mv, engine.turn(), () => {
        engine.move(mv);
        draw();
        // brief pause between an AI's checkers
        setTimeout(stepNext, 160);
      });
    };
    stepNext();
  }

  // Slide a checker from mv.from to mv.to, then invoke done() (which applies it to the engine).
  function animateMove(mv, color, done) {
    const st = engine.state();
    const fromN = mv.from === 'bar' ? (st.bar[color] - 1) : (st.points[mv.from].count - 1);
    const toN = mv.to === 'off' ? 0 : st.points[mv.to].count - (mv.hit ? 0 : 0);
    anim = { from: mv.from, to: mv.to, color, fromN: Math.max(0, fromN), toN: Math.max(0, toN), t: 0 };
    if (stopAnim) stopAnim();
    const DUR = 220;
    stopAnim = animate((ms) => {
      anim.t = Math.min(1, ms / DUR);
      draw();
      if (anim.t >= 1) { anim = null; stopAnim = null; done(); return false; }
      return true;
    });
  }

  // ---- human input ----------------------------------------------------------------------------
  function onDown(ev) {
    if (busy || over) return;
    const turn = engine.turn();
    if (isOnline()) { if (!ctx.net.isReady() || turn !== myColour() || anim) return; } // one move at a time
    else if (mode === 'ai' && turn !== HUMAN) return;
    const st = engine.state();
    if (!st.rolled) { ui.status('Roll the dice first.'); return; }
    ev.preventDefault();
    const { x, y } = pointerXY(canvas, ev);
    const hit = hitTest(x, y);
    if (hit === null) { selected = null; legalTargets = []; draw(); return; }

    // If a source is selected and the click is a legal destination, play it.
    if (selected !== null) {
      const target = legalTargets.find((m) => (hit === 'off' ? m.to === 'off' : m.to === hit));
      if (target) { playHumanMove(target); return; }
    }

    // Otherwise treat the click as selecting a source.
    if (hit === 'bar') {
      if (st.bar[turn] > 0) { select('bar'); return; }
    } else if (typeof hit === 'number') {
      const p = st.points[hit];
      if (p.color === turn && engine.legalMovesFrom(hit).length) { select(hit); return; }
      // Forced bar entry: remind the player.
      if (st.bar[turn] > 0) { ui.status('You must enter from the bar first.'); return; }
    }
    selected = null; legalTargets = []; draw();
  }

  function select(src) {
    selected = src;
    legalTargets = engine.legalMovesFrom(src);
    if (!legalTargets.length) { selected = null; ui.status('No legal move from there.'); }
    draw();
  }

  function playHumanMove(target) {
    lastMove = { from: target.from, to: target.to };
    const color = engine.turn();
    animateMove(target, color, () => {
      const res = engine.move(target);
      selected = null; legalTargets = [];
      if (res.hit) ui.status('Hit! An opponent checker goes to the bar.');
      if (isOnline()) {
        // Relay just {from,to}; the peer re-derives the die/hit/bear-off from its own legal list. Hand
        // the turn to the opponent only when this move completes it (no dice left, or no legal play).
        const complete = engine.state().movesLeft.length === 0 || !engine.canMove();
        ctx.net.send({ from: target.from, to: target.to }, complete ? otherSeat() : onlineSeat);
      }
      draw();
      settleAfterMove();
    });
  }

  // ---- lifecycle ------------------------------------------------------------------------------
  const rollBtn = document.createElement('button');
  rollBtn.textContent = '🎲 Roll dice';
  rollBtn.addEventListener('click', doRoll);
  gameControls.appendChild(rollBtn);

  canvas.addEventListener('mousedown', onDown);
  canvas.addEventListener('touchstart', onDown, { passive: false });

  // Shared (re)initialisation for both a fresh game and a resumed share link: re-read the mode/level,
  // reset transient view state, size the canvas, redraw and prompt. The Roll button and canvas input
  // are wired once at mount (above) and simply re-enabled here via refreshUI(). Finally, hand off to
  // the AI if it's their turn (e.g. a link resumed on the AI's roll).
  function initView(statusMsg) {
    mode = ctx.getMode();
    difficulty = ctx.getDifficulty();
    over = false; busy = false; selected = null; legalTargets = []; lastMove = null; anim = null;
    if (stopAnim) { stopAnim(); stopAnim = null; }
    layout();
    ui.result(null);
    if (statusMsg) ui.status(statusMsg);
    draw();
    refreshUI();
    maybeRunAI(); // (no-op unless it's the AI's turn; human is always white in ai mode)
  }

  function newGame() {
    onlineSeat = -1; // a fresh local game leaves online play
    engine.reset();
    initView('White to start — roll the dice.');
  }

  // ---- online play (optional harness contract; see web/board.js + web/net.js) -----------------
  // Replay the ordered move-log (rolls AND checker moves) to reach the live position. Rolls set the
  // dice from the shared uint32; each checker move is re-matched against the engine's own legal list,
  // so a peer can never inject an illegal state. A turn ends exactly when the engine is out of legal
  // play — the same rule live settling uses — so this reproduces mid-turn state faithfully. A `pass`
  // entry is the explicit hand-off a rolled-but-stuck player sends (a roll alone can't change turn).
  function replayLog(log = []) {
    for (const e of log) {
      if (e.kind === 'random') {
        const [d1, d2] = diceFromU32(e.value);
        engine.roll(d1, d2);
      } else if (e.kind === 'move' && e.payload) {
        if (e.payload.pass) { engine.endTurn(); continue; }
        const res = engine.move({ from: e.payload.from, to: e.payload.to });
        if (!res.ok) continue;
        lastMove = { from: e.payload.from, to: e.payload.to };
        if (engine.state().movesLeft.length === 0 || !engine.canMove()) engine.endTurn();
      }
    }
  }

  // Enter online play at our seat: fresh engine, replay any existing log (a mid-game join hands us a
  // populated one), then paint. onlineSeat gates input/rolls to our colour's turns.
  function onlineStart({ seat, log = [] }) {
    onlineSeat = seat;
    gameOverSent = false;
    over = false; busy = false; selected = null; legalTargets = []; lastMove = null; anim = null;
    if (stopAnim) { stopAnim(); stopAnim = null; }
    engine.reset();
    replayLog(log);
    layout();
    ui.result(null);
    draw();
    refreshUI();
  }

  function setOnlineReady() { draw(); refreshUI(); } // ready-state changed → repaint banners/gating

  // Full re-sync (reconnect or mid-game join): rebuild the position from the authoritative log.
  function onlineResync(log = []) {
    over = false; busy = false; selected = null; legalTargets = []; lastMove = null; anim = null;
    if (stopAnim) { stopAnim(); stopAnim = null; }
    engine.reset();
    replayLog(log);
    draw();
    refreshUI();
  }

  // An authoritative roll arrived (ours or the peer's). Both clients apply the identical dice. If the
  // roll has no legal play the turn must be handed off explicitly — the roller sends a `pass` move.
  function applyRemoteRandom(value, seat) {
    if (over) return;
    const [d1, d2] = diceFromU32(value);
    const r = engine.roll(d1, d2);
    selected = null; legalTargets = []; lastMove = null;
    const who = engine.turn() === 'w' ? 'White' : 'Black';
    draw();
    if (!r.canMove) {
      ui.status(`${who} rolled ${d1}-${d2} — no legal move.`);
      if (seat === onlineSeat) { ctx.net.send({ pass: true }, otherSeat()); engine.endTurn(); afterTurnChange(); }
      else refreshUI(); // wait for the roller's pass to advance the turn
      return;
    }
    ui.status(`Rolled ${d1}-${d2}.`);
    refreshUI();
  }

  // Apply a peer's checker move or their explicit pass. Applied SYNCHRONOUSLY in arrival order (no
  // slide) on purpose: a turn relays several moves back-to-back, and an animation whose engine.move
  // ran in a done-callback would be cancelled by the next arrival before it applied — silently
  // dropping a checker. engine.move validates against its own legal list, so a desynced/illegal
  // payload is ignored rather than corrupting the board. The last move keeps its highlight ring.
  function applyRemoteMove(payload) {
    if (over || !payload) return;
    if (payload.pass) { engine.endTurn(); afterTurnChange(); return; }
    const res = engine.move({ from: payload.from, to: payload.to });
    if (!res.ok) { draw(); refreshUI(); return; }
    lastMove = { from: payload.from, to: payload.to };
    selected = null; legalTargets = [];
    draw();
    settleAfterMove();
  }

  return {
    newGame,
    setMode(m) { mode = m; if (m !== 'online') newGame(); }, // online games start via onlineStart
    setDifficulty(l) { difficulty = l; },
    onlineStart,
    setOnlineReady,
    applyRemoteMove,
    applyRemoteRandom,
    onlineResync,

    // ---- shareable position links (optional controller methods used by board.js) ----
    // Encode the current position for a ?state= link. Always returns a token (the opening position is
    // itself shareable); board.js only shows "nothing to share" if this returns null.
    getShareToken() { return engine.serialize(); },

    // Resume from a share token: restore the engine, then fully (re)initialise the view exactly like a
    // new game (canvas, input, Roll button, redraw, prompt). Returns false — leaving the current game
    // intact — if the token is malformed or checker-count-inconsistent.
    loadShare(token) {
      if (!engine.deserialize(token)) return false;
      const who = engine.turn() === 'w' ? 'White' : 'Black';
      // initView hands off to the AI if it's black's turn in ai mode, overwriting this prompt.
      initView(`Resumed shared position — ${who} to roll.`);
      return true;
    },

    undo() {
      if (busy || over || isOnline()) return; // a networked game can't be unilaterally taken back
      if (mode === 'ai' && engine.turn() !== HUMAN) return;
      if (engine.undo()) {
        selected = null; legalTargets = []; lastMove = null;
        ui.status('Move undone.');
        draw();
        refreshUI();
      }
    },
    resize() { layout(); draw(); },
    destroy() {
      if (stopAnim) stopAnim();
      canvas.removeEventListener('mousedown', onDown);
      canvas.removeEventListener('touchstart', onDown);
      rollBtn.remove();
    },
    rulesHtml: `
      <h4>Object</h4>
      <ul><li>Move all fifteen of your checkers into your home board, then bear them all off. First to bear off all fifteen wins.</li></ul>
      <h4>Moving</h4>
      <ul>
        <li>White and Black move in <em>opposite</em> directions, each toward its own home board (bottom-right for White, top-right for Black).</li>
        <li>Roll two dice and move one checker for each die, in either order. You may split the dice between two checkers or play both on one.</li>
        <li><strong>Doubles</strong> are played four times — e.g. 5-5 gives four moves of five.</li>
        <li>You must use as many dice as you legally can; if only one die can be played, you must play the larger.</li>
        <li>A checker may land on an empty point, one of your own points, or a point holding a single enemy checker.</li>
      </ul>
      <h4>Hitting &amp; the bar</h4>
      <ul>
        <li>Landing on a lone enemy checker (a <em>blot</em>) sends it to the <strong>bar</strong>.</li>
        <li>Checkers on the bar must re-enter in the opponent's home board before you may make any other move. If you cannot enter, your turn is forfeit.</li>
      </ul>
      <h4>Bearing off</h4>
      <ul>
        <li>Once all fifteen of your checkers are in your home board you may bear them off.</li>
        <li>Bear a checker off with the exact roll, or with a higher roll only when no checker sits on a higher point.</li>
      </ul>
      <h4>Note</h4>
      <ul><li>This is single-point play — the doubling cube and gammon/backgammon scoring are not included.</li></ul>
    `,
  };
}
