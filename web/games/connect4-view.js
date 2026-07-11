// connect4-view.js — Canvas 2D view + controller for Connect Four, driving src/board/connect4.js
// through the shared board-game harness (web/board.js). Red moves first; in AI mode the human is Red.
// Implements the optional ONLINE contract (onlineStart / setOnlineReady / applyRemoteMove /
// onlineResync): a move is the column {col}, replayed deterministically by each client's engine.

import { THEME, fitCanvas, pointerXY, think, animate, easeIn, AI_PRE_MS, AI_POST_MS } from './board-common.js';
import { createConnect4 } from '../../src/board/connect4.js';

const COLS = 7, ROWS = 6;
const HUMAN = 'r';                          // human colour in AI mode (Red moves first)
const colourName = { r: 'Red', y: 'Yellow' };
// Online seat ↔ colour: seat 0 (creator) is Red and moves first (matches the relay's turn-0 rule);
// seat 1 is Yellow.
const COLOUR_FOR_SEAT = ['r', 'y'];
const seatForColour = (c) => (c === 'r' ? 0 : 1);

const BOARD = '#22539e', BOARD_HI = '#2f66bd', HOLE = '#12233f';

export default function mount(ctx) {
  const { canvas, box, ui } = ctx;
  const engine = createConnect4();

  // --- view state -----------------------------------------------------------------------------
  let g2 = canvas.getContext('2d');
  let geo = { w: 0, h: 0, cell: 60, ox: 0, oy: 0 };
  let lastMove = null;                 // {r,c} of the most recent drop (screen highlight)
  let hoverCol = -1;                   // column under the pointer (a drop-preview marker)
  let anim = null;                     // { col, row, color, y } falling-disc overlay
  let stopAnim = null;                 // canceller for the active drop animation
  let aiPending = false;
  let epoch = 0;
  let destroyed = false;
  let onlineSeat = -1;
  let gameOverSent = false;

  // --- geometry -------------------------------------------------------------------------------
  function layout() {
    const fit = fitCanvas(canvas, box, { square: false });
    g2 = fit.ctx;
    const cell = Math.min(fit.w / COLS, fit.h / ROWS);
    geo = { w: fit.w, h: fit.h, cell, ox: (fit.w - cell * COLS) / 2, oy: (fit.h - cell * ROWS) / 2 };
  }
  const colX = (c) => geo.ox + (c + 0.5) * geo.cell;
  const rowY = (r) => geo.oy + (ROWS - 1 - r + 0.5) * geo.cell; // engine row 0 = bottom of the screen
  function colAt(x) { const c = Math.floor((x - geo.ox) / geo.cell); return c >= 0 && c < COLS ? c : -1; }

  // --- rendering ------------------------------------------------------------------------------
  function draw() {
    const g = g2;
    g.clearRect(0, 0, geo.w, geo.h);
    const rad = geo.cell * 0.4;

    // drop-preview marker above the hovered column (only when the human may drop there)
    if (hoverCol >= 0 && isHumanTurn() && !aiPending && !engine.status().over && engine.legalMoves().includes(hoverCol)) {
      g.beginPath(); g.arc(colX(hoverCol), geo.oy - geo.cell * 0.05, rad * 0.7, 0, Math.PI * 2);
      g.fillStyle = engine.turn() === 'r' ? 'rgba(226,76,74,0.5)' : 'rgba(240,200,70,0.5)';
      g.fill();
    }

    // blue board with circular holes; discs show through the holes
    g.fillStyle = BOARD;
    g.fillRect(geo.ox, geo.oy, geo.cell * COLS, geo.cell * ROWS);
    if (hoverCol >= 0 && !engine.status().over) {
      g.fillStyle = BOARD_HI;
      g.fillRect(geo.ox + hoverCol * geo.cell, geo.oy, geo.cell, geo.cell * ROWS);
    }
    const board = engine.board();
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        // The disc that's mid-drop hasn't landed yet — show its destination as an empty hole.
        if (anim && anim.row === r && anim.col === c) { g.beginPath(); g.arc(colX(c), rowY(r), rad, 0, Math.PI * 2); g.fillStyle = HOLE; g.fill(); continue; }
        const p = board[r][c];
        if (p) drawDisc(g, colX(c), rowY(r), p, rad);
        else { g.beginPath(); g.arc(colX(c), rowY(r), rad, 0, Math.PI * 2); g.fillStyle = HOLE; g.fill(); }
      }
    }
    if (lastMove && !anim) {
      g.beginPath(); g.arc(colX(lastMove.c), rowY(lastMove.r), rad + 3, 0, Math.PI * 2);
      g.strokeStyle = THEME.lastMove; g.lineWidth = 3; g.stroke();
    }
    if (anim) drawDisc(g, colX(anim.col), anim.y, anim.color, rad); // the falling coin, on top
  }

  // Drop a coin from above the board down its column to the resting row, then invoke done(). An
  // accelerating fall (gravity) with a small bounce settle. The engine move is applied by the caller
  // BEFORE this runs, so draw() already knows the final layout — it just hides the landed disc until
  // the coin arrives. Single move per turn, so drops never overlap.
  function animateDrop(row, col, color, done) {
    if (stopAnim) { stopAnim(); stopAnim = null; }
    const y0 = geo.oy - geo.cell * 0.5;   // start just above the frame
    const y1 = rowY(row);
    const dist = y1 - y0;
    const DUR = Math.max(180, 120 + row * 42); // a longer fall for higher stacks
    anim = { col, row, color, y: y0 };
    stopAnim = animate((t) => {
      const k = Math.min(1, t / DUR);
      // accelerate down, then a quick 6% bounce as it seats
      const e = k < 0.85 ? easeIn(k / 0.85) : 1 + Math.sin((k - 0.85) / 0.15 * Math.PI) * 0.06;
      anim.y = y0 + dist * e;
      if (k >= 1) { anim = null; stopAnim = null; draw(); done(); return false; }
      draw();
      return true;
    });
  }

  function drawDisc(g, x, y, color, rad) {
    const grad = g.createRadialGradient(x - rad * 0.35, y - rad * 0.35, rad * 0.2, x, y, rad);
    if (color === 'r') { grad.addColorStop(0, '#ff6b68'); grad.addColorStop(1, '#c0322f'); }
    else { grad.addColorStop(0, '#ffe08a'); grad.addColorStop(1, '#e0b32e'); }
    g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fillStyle = grad; g.fill();
    g.lineWidth = 1.5; g.strokeStyle = color === 'r' ? '#8f2320' : '#a8841f'; g.stroke();
    g.beginPath(); g.arc(x, y, rad * 0.5, 0, Math.PI * 2);
    g.strokeStyle = 'rgba(0,0,0,0.12)'; g.stroke();
  }

  // --- turn / status --------------------------------------------------------------------------
  function refreshBanners() {
    const st = engine.status();
    ui.setUndo(!isOnline() && engine.history().length > 0 && !aiPending);
    if (st.over) {
      if (isOnline() && !gameOverSent) {
        gameOverSent = true;
        ctx.net.sendGameOver(st.winner ? seatForColour(st.winner) : null); // draw → null
      }
      ui.turn(null);
      ui.result(st.winner ? `${colourName[st.winner]} wins` : 'Draw');
      ui.status(st.reason);
      return;
    }
    ui.result(null);
    const t = engine.turn();
    if (isOnline()) {
      if (!ctx.net.isReady()) { ui.turn('Waiting for opponent…'); ui.status(`You are ${colourName[myColour()]}.`); return; }
      ui.turn(t === myColour() ? `Your move — ${colourName[t]}` : `Opponent to move — ${colourName[t]}`);
      ui.status('');
      return;
    }
    if (isHumanTurn()) { ui.turn(`${colourName[t]} to move`); ui.status('Drop a disc.'); }
    else { ui.turn('AI is thinking…'); ui.status(''); }
  }

  const isAiMode = () => ctx.getMode() === 'ai';
  const isOnline = () => onlineSeat >= 0 && !!ctx.net?.isOnline();
  const myColour = () => COLOUR_FOR_SEAT[onlineSeat];
  function isHumanTurn() {
    if (isOnline()) return ctx.net.isReady() && engine.turn() === myColour();
    return !isAiMode() || engine.turn() === HUMAN;
  }

  // --- input ----------------------------------------------------------------------------------
  function onPointerDown(ev) {
    if (destroyed || aiPending || anim || engine.status().over) return;
    if (!isHumanTurn()) return;
    ev.preventDefault();
    const { x } = pointerXY(canvas, ev);
    const col = colAt(x);
    if (col < 0) return;
    const color = engine.turn();
    const res = engine.move({ col });
    if (!res.ok) return;                        // full column — ignore
    lastMove = { r: res.row, c: col };
    hoverCol = -1;
    refreshBanners();
    if (isOnline()) ctx.net.send({ col }, seatForColour(engine.turn()));
    animateDrop(res.row, col, color, () => { if (!isOnline()) maybeAiTurn(); });
  }
  function onMove(ev) {
    if (destroyed || anim || aiPending || engine.status().over || !isHumanTurn()) { if (hoverCol !== -1) { hoverCol = -1; draw(); } return; }
    const { x } = pointerXY(canvas, ev);
    const col = colAt(x);
    if (col !== hoverCol) { hoverCol = col; draw(); }
  }
  function onLeave() { if (hoverCol !== -1) { hoverCol = -1; draw(); } }

  // --- AI -------------------------------------------------------------------------------------
  // AI turn, deliberately paced: a "thinking" beat (AI_PRE_MS) before the coin appears, then the drop
  // animation, then a settle beat (AI_POST_MS) before you're back on.
  function maybeAiTurn() {
    if (destroyed || !isAiMode() || isOnline()) return;
    if (engine.status().over || engine.turn() === HUMAN) return;
    aiPending = true;
    refreshBanners();
    const myEpoch = epoch;
    think(() => engine.aiMove(ctx.getDifficulty()), (move) => {
      if (destroyed || myEpoch !== epoch) return;
      if (!move) { aiPending = false; refreshBanners(); return; }
      const color = engine.turn();
      const res = engine.move(move);
      lastMove = { r: res.row, c: move.col };
      refreshBanners();
      animateDrop(res.row, move.col, color, () => {
        setTimeout(() => {
          if (destroyed || myEpoch !== epoch) return;
          aiPending = false;
          refreshBanners();
        }, AI_POST_MS);
      });
    }, AI_PRE_MS);
  }

  // --- controller -----------------------------------------------------------------------------
  function cancelAnim() { if (stopAnim) { stopAnim(); stopAnim = null; } anim = null; }
  function startView() { cancelAnim(); lastMove = null; hoverCol = -1; aiPending = false; layout(); draw(); refreshBanners(); maybeAiTurn(); }
  function newGame() { epoch++; onlineSeat = -1; engine.reset(); startView(); }

  function undo() {
    if (isOnline() || aiPending || anim) return;
    if (!engine.history().length) return;
    epoch++;
    engine.undo();
    if (isAiMode() && engine.history().length && engine.turn() !== HUMAN) engine.undo();
    const h = engine.history();
    if (h.length) { const last = h[h.length - 1]; const b = engine.board(); // recover the row of the last drop
      let row = -1; for (let r = ROWS - 1; r >= 0; r--) if (b[r][last.col]) { row = r; break; } lastMove = { r: row, c: last.col };
    } else lastMove = null;
    draw();
    refreshBanners();
  }

  // --- online play ----------------------------------------------------------------------------
  function replayLog(log = []) {
    let last = null;
    for (const e of log) {
      if (e.kind !== 'move' || !e.payload) continue;
      const res = engine.move({ col: e.payload.col });
      if (res.ok) last = { r: res.row, c: e.payload.col };
    }
    lastMove = last;
  }
  function onlineStart({ seat, log = [] }) {
    epoch++; onlineSeat = seat; gameOverSent = false; aiPending = false; cancelAnim();
    engine.reset(); replayLog(log); layout(); draw(); refreshBanners();
  }
  function setOnlineReady() { refreshBanners(); }
  function applyRemoteMove(payload) {
    if (destroyed || !payload) return;
    const color = engine.turn();
    const res = engine.move({ col: payload.col });
    if (!res.ok) return;
    lastMove = { r: res.row, c: payload.col };
    refreshBanners();
    animateDrop(res.row, payload.col, color, () => {}); // watch the opponent's coin fall
  }
  function onlineResync(log = []) { cancelAnim(); engine.reset(); replayLog(log); draw(); refreshBanners(); }

  // --- listeners ------------------------------------------------------------------------------
  canvas.addEventListener('mousedown', onPointerDown);
  canvas.addEventListener('touchstart', onPointerDown, { passive: false });
  canvas.addEventListener('mousemove', onMove);
  canvas.addEventListener('mouseleave', onLeave);

  layout();
  draw();

  return {
    newGame,
    setMode(mode) { if (mode !== 'online') newGame(); },
    setDifficulty() { /* applies on the AI's next search */ },
    undo,
    resize() { cancelAnim(); layout(); draw(); },
    destroy() {
      destroyed = true; epoch++; cancelAnim();
      canvas.removeEventListener('mousedown', onPointerDown);
      canvas.removeEventListener('touchstart', onPointerDown);
      canvas.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('mouseleave', onLeave);
    },

    onlineStart, setOnlineReady, applyRemoteMove, onlineResync,

    getShareToken() { return engine.serialize(); },
    loadShare(token) { if (!engine.deserialize(token)) return false; epoch++; startView(); return true; },

    rulesHtml: `
      <h4>Object</h4>
      <ul><li>Be the first to line up <b>four</b> of your discs in a row — horizontally, vertically or diagonally. <b>Red</b> moves first.</li></ul>
      <h4>Moving</h4>
      <ul>
        <li>Click a column to <b>drop</b> a disc; it falls to the lowest empty slot.</li>
        <li>Discs stack from the bottom, so a column fills up and eventually closes.</li>
        <li>A full board with no four is a <b>draw</b>.</li>
      </ul>
      <h4>Modes</h4>
      <ul>
        <li><b>You vs AI</b> — you play Red and move first. Easy / Medium / Hard.</li>
        <li><b>Two players</b> — hot-seat on one device.</li>
        <li><b>Play online</b> — the room creator is Red; share the code or invite a friend.</li>
      </ul>`,
  };
}
