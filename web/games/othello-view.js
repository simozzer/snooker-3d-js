// othello-view.js — Canvas 2D view + controller for Reversi/Othello, driving the DOM-free engine in
// src/board/othello.js through the shared board-game harness (web/board.js). Black moves first; in AI
// mode the human is Black. It implements the optional ONLINE contract (onlineStart / setOnlineReady /
// applyRemoteMove / onlineResync), so Othello is playable online — moves are the single cell {r,c},
// replayed deterministically by each client's engine. Passes are handled inside the engine, so no
// special "pass" plumbing is needed here.

import { THEME, fitCanvas, pointerXY, think } from './board-common.js';
import { createOthello } from '../../src/board/othello.js';

const HUMAN = 'b';                          // human colour in AI mode (Black moves first)
const colourName = { b: 'Black', w: 'White' };
// Online seat ↔ colour: seat 0 (creator) is Black and moves first (matches the relay's turn-0 rule);
// seat 1 is White.
const COLOUR_FOR_SEAT = ['b', 'w'];
const seatForColour = (c) => (c === 'b' ? 0 : 1);

export default function mount(ctx) {
  const { canvas, box, ui } = ctx;
  const engine = createOthello();

  // --- view state -----------------------------------------------------------------------------
  let dims = { w: 480, h: 480, ctx: canvas.getContext('2d') };
  let cell = 60;
  let lastMove = null;                 // {r,c} of the most recent placement, for a highlight ring
  let aiPending = false;
  let epoch = 0;                       // bumped on new game / destroy to void stale AI callbacks
  let destroyed = false;
  let onlineSeat = -1;                 // our seat (0/1) online, or -1 offline
  let gameOverSent = false;

  // --- geometry -------------------------------------------------------------------------------
  function layout() { dims = fitCanvas(canvas, box); cell = dims.w / 8; }
  const cx = (c) => (c + 0.5) * cell;
  const cy = (r) => (r + 0.5) * cell;
  function hit(x, y) {
    const c = Math.floor(x / cell), r = Math.floor(y / cell);
    return (r >= 0 && r < 8 && c >= 0 && c < 8) ? { r, c } : null;
  }

  // --- rendering ------------------------------------------------------------------------------
  function draw() {
    const g = dims.ctx;
    g.clearRect(0, 0, dims.w, dims.h);
    // felt + grid
    g.fillStyle = '#14795a';
    g.fillRect(0, 0, dims.w, dims.h);
    g.strokeStyle = 'rgba(0,0,0,0.35)';
    g.lineWidth = 1;
    for (let i = 0; i <= 8; i++) {
      g.beginPath(); g.moveTo(i * cell, 0); g.lineTo(i * cell, dims.h); g.stroke();
      g.beginPath(); g.moveTo(0, i * cell); g.lineTo(dims.w, i * cell); g.stroke();
    }
    // the four small guide pips of a real Othello board (at the 2/6 intersections)
    g.fillStyle = 'rgba(0,0,0,0.5)';
    for (const [r, c] of [[2, 2], [2, 6], [6, 2], [6, 6]]) {
      g.beginPath(); g.arc(c * cell, r * cell, cell * 0.06, 0, Math.PI * 2); g.fill();
    }

    const board = engine.board();
    const showHints = isHumanTurn() && !aiPending && !engine.status().over;
    const legal = showHints ? new Set(engine.legalMoves().map((m) => `${m.r},${m.c}`)) : null;

    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const p = board[r][c];
        if (p) { drawDisc(g, cx(c), cy(r), p); continue; }
        if (legal && legal.has(`${r},${c}`)) {
          g.beginPath(); g.arc(cx(c), cy(r), cell * 0.12, 0, Math.PI * 2);
          g.fillStyle = engine.turn() === 'b' ? 'rgba(20,20,25,0.4)' : 'rgba(245,245,245,0.4)';
          g.fill();
        }
      }
    }
    if (lastMove) {
      g.beginPath(); g.arc(cx(lastMove.c), cy(lastMove.r), cell * 0.44, 0, Math.PI * 2);
      g.strokeStyle = THEME.lastMove; g.lineWidth = 3; g.stroke();
    }
  }

  function drawDisc(g, x, y, color) {
    const rad = cell * 0.4;
    g.beginPath(); g.arc(x, y + rad * 0.1, rad, 0, Math.PI * 2);
    g.fillStyle = 'rgba(0,0,0,0.3)'; g.fill(); // shadow
    const grad = g.createRadialGradient(x - rad * 0.35, y - rad * 0.35, rad * 0.2, x, y, rad);
    if (color === 'b') { grad.addColorStop(0, '#4a4a52'); grad.addColorStop(1, '#17171c'); }
    else { grad.addColorStop(0, '#ffffff'); grad.addColorStop(1, '#d8d2c4'); }
    g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fillStyle = grad; g.fill();
    g.lineWidth = 1.5; g.strokeStyle = color === 'b' ? '#000' : '#b4ad9c'; g.stroke();
  }

  // --- turn / status --------------------------------------------------------------------------
  function refreshBanners() {
    const st = engine.status();
    ui.setUndo(!isOnline() && engine.history().length > 0 && !aiPending);
    const cnt = st.counts;
    if (st.over) {
      if (isOnline() && !gameOverSent) {
        gameOverSent = true;
        ctx.net.sendGameOver(st.winner ? seatForColour(st.winner) : null); // tie → null
      }
      ui.turn(null);
      ui.result(st.winner ? `${colourName[st.winner]} wins` : 'Draw');
      ui.status(st.reason);
      return;
    }
    ui.result(null);
    const t = engine.turn();
    const score = `● ${cnt.b}  ○ ${cnt.w}`;
    if (isOnline()) {
      if (!ctx.net.isReady()) { ui.turn('Waiting for opponent…'); ui.status(`You are ${colourName[myColour()]}. ${score}`); return; }
      ui.turn(t === myColour() ? `Your move — ${colourName[t]}` : `Opponent to move — ${colourName[t]}`);
      ui.status(score);
      return;
    }
    if (isHumanTurn()) { ui.turn(`${colourName[t]} to move`); ui.status(score); }
    else { ui.turn('AI is thinking…'); ui.status(score); }
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
    if (destroyed || aiPending || engine.status().over) return;
    if (!isHumanTurn()) return;
    ev.preventDefault();
    const { x, y } = pointerXY(canvas, ev);
    const sq = hit(x, y);
    if (!sq) return;
    const res = engine.move(sq);
    if (!res.ok) return;                        // not a legal placement — ignore
    lastMove = sq;
    draw();
    refreshBanners();
    if (isOnline()) ctx.net.send({ r: sq.r, c: sq.c }, seatForColour(engine.turn()));
    else maybeAiTurn();
  }

  // --- AI -------------------------------------------------------------------------------------
  function maybeAiTurn() {
    if (destroyed || !isAiMode() || isOnline()) return;
    if (engine.status().over || engine.turn() === HUMAN) return;
    aiPending = true;
    refreshBanners();
    const myEpoch = epoch;
    think(() => engine.aiMove(ctx.getDifficulty()), (move) => {
      if (destroyed || myEpoch !== epoch) return;
      aiPending = false;
      if (!move) { refreshBanners(); return; }
      engine.move(move);
      lastMove = move;
      draw();
      refreshBanners();
      maybeAiTurn(); // the human may have been auto-passed → AI to move again
    });
  }

  // --- controller -----------------------------------------------------------------------------
  function startView() {
    lastMove = null;
    aiPending = false;
    layout();
    draw();
    refreshBanners();
    maybeAiTurn();
  }
  function newGame() { epoch++; onlineSeat = -1; engine.reset(); startView(); }

  function undo() {
    if (isOnline() || aiPending) return;
    if (!engine.history().length) return;
    epoch++;
    engine.undo();
    if (isAiMode() && engine.history().length && engine.turn() !== HUMAN) engine.undo();
    const h = engine.history();
    lastMove = h.length ? h[h.length - 1] : null;
    draw();
    refreshBanners();
  }

  // --- online play ----------------------------------------------------------------------------
  function replayLog(log = []) {
    let last = null;
    for (const e of log) {
      if (e.kind !== 'move' || !e.payload) continue;
      if (engine.move({ r: e.payload.r, c: e.payload.c }).ok) last = { r: e.payload.r, c: e.payload.c };
    }
    lastMove = last;
  }
  function onlineStart({ seat, log = [] }) {
    epoch++;
    onlineSeat = seat;
    gameOverSent = false;
    aiPending = false;
    engine.reset();
    replayLog(log);
    layout();
    draw();
    refreshBanners();
  }
  function setOnlineReady() { refreshBanners(); }
  function applyRemoteMove(payload) {
    if (destroyed || !payload) return;
    if (!engine.move({ r: payload.r, c: payload.c }).ok) return; // illegal/desynced → ignore
    lastMove = { r: payload.r, c: payload.c };
    draw();
    refreshBanners();
  }
  function onlineResync(log = []) {
    engine.reset();
    replayLog(log);
    draw();
    refreshBanners();
  }

  // --- listeners ------------------------------------------------------------------------------
  canvas.addEventListener('mousedown', onPointerDown);
  canvas.addEventListener('touchstart', onPointerDown, { passive: false });

  layout();
  draw();

  return {
    newGame,
    setMode(mode) { if (mode !== 'online') newGame(); },
    setDifficulty() { /* applies on the AI's next search */ },
    undo,
    resize() { layout(); draw(); },
    destroy() { destroyed = true; epoch++; canvas.removeEventListener('mousedown', onPointerDown); canvas.removeEventListener('touchstart', onPointerDown); },

    onlineStart, setOnlineReady, applyRemoteMove, onlineResync,

    getShareToken() { return engine.serialize(); },
    loadShare(token) { if (!engine.deserialize(token)) return false; epoch++; startView(); return true; },

    rulesHtml: `
      <h4>Object</h4>
      <ul><li>Finish with more discs of your colour than your opponent. <b>Black</b> moves first.</li></ul>
      <h4>Moving</h4>
      <ul>
        <li>Place a disc so that it <b>outflanks</b> one or more of the opponent's discs in a straight line — horizontally, vertically or diagonally — bounded at the far end by one of your own.</li>
        <li>Every outflanked disc <b>flips</b> to your colour. You may only play where at least one disc flips (legal squares are dotted).</li>
        <li>If you have no legal move your turn is <b>passed</b> automatically. When neither side can move the game ends.</li>
      </ul>
      <h4>Modes</h4>
      <ul>
        <li><b>You vs AI</b> — you play Black and move first. Easy / Medium / Hard.</li>
        <li><b>Two players</b> — hot-seat on one device.</li>
        <li><b>Play online</b> — the room creator is Black; share the code or invite a friend.</li>
      </ul>`,
  };
}
