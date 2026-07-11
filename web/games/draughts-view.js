// draughts-view.js — Canvas 2D view + controller for English draughts. Renders the 8x8 board,
// handles mouse/touch selection with the forced-capture and multi-jump rules made visible, drives
// the engine in src/board/draughts.js, and runs the AI off the paint path via think().
//
// Contract (see web/board.js): default-export mount(ctx) -> controller. The human always plays
// 'r' (red, bottom of the board); in 'ai' mode the AI plays 'w' (white, top). Board orientation
// matches the engine: row 0 at the top, row 7 at the bottom, so red naturally sits at the bottom
// with no flipping needed.

import { THEME, fitCanvas, pointerXY, animate, easeOut, think } from './board-common.js';
import { createDraughts } from '../../src/board/draughts.js';

const HUMAN = 'r';                 // human colour in 'ai' mode
const colorName = { r: 'Red', w: 'White' };
// Online seat ↔ colour: seat 0 (the room's creator) is Red and moves first, matching the relay's
// turn-0-first rule and the engine's red-to-move start. Seat 1 is White.
const COLOUR_FOR_SEAT = ['r', 'w'];
const seatForColour = (c) => (c === 'r' ? 0 : 1);

export default function mount(ctx) {
  const { canvas, box, ui } = ctx;
  const engine = createDraughts();

  // --- view state -----------------------------------------------------------------------------
  let dims = { w: 480, h: 480, ctx: canvas.getContext('2d') };
  let cell = 60;
  let selected = null;             // {row,col} of the piece being moved
  let candidates = [];             // legal moves starting at `selected` (filtered by pathSoFar)
  let pathSoFar = [];              // landing squares already chosen this multi-jump
  let lastMove = null;             // {from, to} for the highlight
  let anim = null;                 // active slide animation {stop, ...}
  let aiPending = false;           // an AI search is queued/in flight
  let epoch = 0;                   // bumped on new game / undo / destroy to void stale AI callbacks
  let destroyed = false;
  let onlineSeat = -1;             // our seat (0/1) in an online game, or -1 when offline
  let gameOverSent = false;        // ensure we report a finished online game to the relay only once

  // --- geometry -------------------------------------------------------------------------------
  function layout() {
    dims = fitCanvas(canvas, box);
    cell = dims.w / 8;
  }
  const cx = (col) => (col + 0.5) * cell;
  const cy = (row) => (row + 0.5) * cell;
  function hit(x, y) {
    const col = Math.floor(x / cell), row = Math.floor(y / cell);
    return (row >= 0 && row < 8 && col >= 0 && col < 8) ? { row, col } : null;
  }

  // --- rendering ------------------------------------------------------------------------------
  function draw(floatPiece) {
    const g = dims.ctx;
    g.clearRect(0, 0, dims.w, dims.h);

    // squares
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        g.fillStyle = ((r + c) & 1) ? THEME.sqDark : THEME.sqLight;
        g.fillRect(c * cell, r * cell, cell + 0.5, cell + 0.5);
      }
    }

    // last-move highlight
    if (lastMove) {
      g.fillStyle = THEME.lastMove;
      for (const s of [lastMove.from, lastMove.to]) g.fillRect(s.col * cell, s.row * cell, cell, cell);
    }

    // selection + the squares travelled so far this jump
    if (selected) {
      g.fillStyle = THEME.selected;
      const cur = pathSoFar.length ? pathSoFar[pathSoFar.length - 1] : selected;
      g.fillRect(cur.col * cell, cur.row * cell, cell, cell);
    }

    // pieces (skip the one currently sliding)
    const board = engine.board();
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const p = board[r][c];
        if (!p) continue;
        if (floatPiece && floatPiece.hideRow === r && floatPiece.hideCol === c) continue;
        drawPiece(g, cx(c), cy(r), p);
      }
    }
    if (floatPiece) drawPiece(g, floatPiece.x, floatPiece.y, floatPiece.piece);

    // legal-landing dots for the next hop
    if (selected) {
      const step = pathSoFar.length;
      const seen = new Set();
      g.fillStyle = THEME.legal;
      for (const m of candidates) {
        if (m.path.length <= step) continue;
        const s = m.path[step];
        const key = `${s.row},${s.col}`;
        if (seen.has(key)) continue;
        seen.add(key);
        g.beginPath();
        g.arc(cx(s.col), cy(s.row), cell * 0.14, 0, Math.PI * 2);
        g.fill();
      }
    }
  }

  function drawPiece(g, x, y, piece) {
    const rad = cell * 0.38;
    // drop shadow
    g.beginPath();
    g.arc(x, y + rad * 0.12, rad, 0, Math.PI * 2);
    g.fillStyle = 'rgba(0,0,0,0.35)';
    g.fill();
    // body with a soft bevel
    const isRed = piece.color === 'r';
    const grad = g.createRadialGradient(x - rad * 0.35, y - rad * 0.35, rad * 0.15, x, y, rad);
    if (isRed) { grad.addColorStop(0, '#e2564a'); grad.addColorStop(1, '#a5281f'); }
    else { grad.addColorStop(0, '#fbf4e3'); grad.addColorStop(1, '#cdbd9c'); }
    g.beginPath();
    g.arc(x, y, rad, 0, Math.PI * 2);
    g.fillStyle = grad;
    g.fill();
    // rim
    g.lineWidth = Math.max(1.5, rad * 0.09);
    g.strokeStyle = isRed ? '#7d1c15' : '#a3906a';
    g.stroke();
    // inner groove ring
    g.beginPath();
    g.arc(x, y, rad * 0.66, 0, Math.PI * 2);
    g.lineWidth = Math.max(1, rad * 0.05);
    g.strokeStyle = isRed ? 'rgba(255,255,255,0.18)' : 'rgba(120,90,40,0.35)';
    g.stroke();
    // king crown glyph
    if (piece.king) {
      g.fillStyle = isRed ? '#ffe08a' : '#8a6a2f';
      g.font = `${Math.round(rad * 1.15)}px serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('♚', x, y + rad * 0.06); // ♚
    }
  }

  // --- turn / status plumbing -----------------------------------------------------------------
  function refreshBanners() {
    const s = engine.status();
    ui.setUndo(!isOnline() && engine.history().length > 0 && !aiPending); // no unilateral undo online
    if (s.over) {
      if (isOnline() && !gameOverSent) { // tally the finished game once (draw → null winner)
        gameOverSent = true;
        ctx.net.sendGameOver(s.result === 'draw' ? null : seatForColour(s.winner));
      }
      ui.turn(null);
      ui.result(s.result === 'draw' ? 'Draw' : `${colorName[s.winner]} wins`);
      ui.status(s.result === 'draw' ? 'Drawn game.' : `${colorName[s.winner]} wins — ${s.reason}.`);
      return;
    }
    ui.result(null);
    const t = engine.turn();
    const moves = engine.allLegalMoves();
    const mustTake = moves.length > 0 && moves[0].captures.length > 0; // forced captures come as captures-only

    if (isOnline()) {
      if (!ctx.net.isReady()) { ui.turn('Waiting for opponent…'); ui.status(`You are ${colorName[myColour()]}.`); return; }
      if (isHumanTurn()) { ui.turn(`Your move — ${colorName[t]}`); ui.status(mustTake ? 'You must take.' : ''); }
      else { ui.turn(`Opponent to move — ${colorName[t]}`); ui.status(''); }
      return;
    }

    if (isHumanTurn()) {
      ui.turn(`${colorName[t]} to move`);
      ui.status(mustTake ? 'You must take.' : 'Your move.');
    } else {
      ui.turn('AI is thinking…');
      ui.status('');
    }
  }

  function isAiMode() { return ctx.getMode() === 'ai'; }
  function isOnline() { return onlineSeat >= 0 && ctx.net?.isOnline(); }
  function myColour() { return COLOUR_FOR_SEAT[onlineSeat]; }
  // "Local turn" = this device may move now. Online: both seats present AND it is our colour's turn.
  function isHumanTurn() {
    if (isOnline()) return ctx.net.isReady() && engine.turn() === myColour();
    return !isAiMode() || engine.turn() === HUMAN;
  }

  // --- input ----------------------------------------------------------------------------------
  function clearSelection() { selected = null; candidates = []; pathSoFar = []; }

  function onPointerDown(ev) {
    if (destroyed || anim || aiPending) return;
    if (engine.status().over) return;
    if (!isHumanTurn()) return;
    ev.preventDefault();
    const { x, y } = pointerXY(canvas, ev);
    const sq = hit(x, y);
    if (!sq) return;

    // Mid multi-jump: only accept the next legal hop.
    if (selected && pathSoFar.length) {
      if (tryStep(sq)) return;
      return; // ignore clicks off the continuation
    }

    // Clicking one of the selected piece's landing squares plays (or advances) the move.
    if (selected && tryStep(sq)) return;

    // Otherwise (re)select a piece of the side to move that actually has a legal move.
    const board = engine.board();
    const p = board[sq.row][sq.col];
    if (p && p.color === engine.turn()) {
      const moves = engine.legalMovesFrom(sq);
      if (moves.length) {
        selected = sq; candidates = moves; pathSoFar = [];
        draw();
        return;
      }
      // Selected an own piece that can't move — hint if a capture is forced elsewhere.
      const forced = engine.allLegalMoves().some((m) => m.captures.length > 0);
      ui.status(forced ? 'You must take with another piece.' : 'That piece has no move.');
    }
    clearSelection();
    draw();
  }

  // Advance the current selection by one landing square. Returns true if `sq` was a valid hop.
  function tryStep(sq) {
    const step = pathSoFar.length;
    const next = candidates.filter((m) => m.path.length > step
      && m.path[step].row === sq.row && m.path[step].col === sq.col);
    if (!next.length) return false;
    pathSoFar.push(sq);

    // If exactly one candidate remains, it is fully determined — auto-complete any further hops.
    if (next.length === 1) { commitMove(next[0]); return true; }

    // A completed capture chain among several branches (rare) — one candidate ends here.
    const done = next.find((m) => m.path.length === pathSoFar.length);
    if (done) { commitMove(done); return true; }

    // Multiple continuations: keep the selection and wait for the next click.
    candidates = next;
    draw();
    ui.status('Continue the jump…');
    return true;
  }

  function commitMove(move) {
    clearSelection();
    animateMove(move, () => {
      const res = engine.move(move);
      lastMove = { from: move.from, to: move.path[move.path.length - 1] };
      draw();
      refreshBanners();
      if (!res.ok) return;
      if (isOnline()) {
        // Relay only what the peer's deterministic engine needs to reproduce the move; it re-derives
        // the full move (captures/crowning) from {from,path}. `next` is the seat now to move.
        ctx.net.send({ from: move.from, path: move.path }, seatForColour(engine.turn()));
      } else {
        maybeAiTurn();
      }
    });
  }

  // Slide the moving piece along its path, then invoke done().
  function animateMove(move, done) {
    const piece = engine.board()[move.from.row][move.from.col];
    if (!piece) { done(); return; }
    const stops = [move.from, ...move.path];
    const perHop = 130;
    const total = perHop * (stops.length - 1);
    if (anim) anim();
    anim = animate((t) => {
      const prog = total ? t / total : 1;
      const seg = Math.min(stops.length - 2, Math.floor(prog * (stops.length - 1)));
      const local = easeOut((prog * (stops.length - 1)) - seg);
      const a = stops[seg], b = stops[seg + 1] || a;
      const x = cx(a.col) + (cx(b.col) - cx(a.col)) * local;
      const y = cy(a.row) + (cy(b.row) - cy(a.row)) * local;
      draw({ x, y, piece, hideRow: move.from.row, hideCol: move.from.col });
      if (t >= total) { anim = null; done(); return false; }
      return true;
    });
  }

  // --- AI turn --------------------------------------------------------------------------------
  function maybeAiTurn() {
    if (destroyed || !isAiMode()) return;
    if (engine.status().over || engine.turn() === HUMAN) return;
    aiPending = true;
    refreshBanners();
    const myEpoch = epoch;
    think(() => engine.aiMove(ctx.getDifficulty()), (move) => {
      if (destroyed || myEpoch !== epoch) return; // superseded by new game / undo
      aiPending = false;
      if (!move) { refreshBanners(); return; }
      animateMove(move, () => {
        engine.move(move);
        lastMove = { from: move.from, to: move.path[move.path.length - 1] };
        draw();
        refreshBanners();
        maybeAiTurn(); // in case the (human) opponent is somehow still not to move
      });
    });
  }

  // --- controller -----------------------------------------------------------------------------
  // Shared (re)initialisation for both newGame() and loadShare(): the caller sets the engine
  // position first; this clears transient state, paints, updates the banners, and hands off to the
  // AI if it is already White's move (e.g. a shared position with White to play).
  function startView() {
    clearSelection();
    lastMove = null;
    aiPending = false;
    if (anim) { anim(); anim = null; }
    layout();
    draw();
    refreshBanners();
    maybeAiTurn();
  }

  function newGame() {
    epoch++;
    onlineSeat = -1;
    engine.reset();
    startView();
  }

  function undo() {
    if (isOnline()) return;          // a networked game can't be unilaterally taken back
    if (aiPending || anim) return;
    if (!engine.history().length) return;
    epoch++;
    // Revert to the human's previous decision: in AI mode pop the AI reply and the human move.
    engine.undo();
    if (isAiMode() && engine.history().length && engine.turn() !== HUMAN) engine.undo();
    clearSelection();
    const h = engine.history();
    const last = h[h.length - 1];
    lastMove = last ? { from: last.from, to: last.to } : null;
    draw();
    refreshBanners();
  }

  // --- online play ----------------------------------------------------------------------------
  // Replay the ordered move-log (no animation) to reach the live position. Each entry's {from,path}
  // is re-matched against the engine's own legal moves, so a peer can never inject an illegal state.
  // Draughts has no `random` entries; those are skipped defensively.
  function replayLog(log = []) {
    let last = null;
    for (const e of log) {
      if (e.kind !== 'move' || !e.payload) continue;
      const move = { from: e.payload.from, path: e.payload.path };
      if (engine.move(move).ok) last = { from: move.from, to: move.path[move.path.length - 1] };
    }
    lastMove = last;
  }

  // Enter online play at our seat: fresh engine, replay any existing log (a mid-game join hands us a
  // populated log), then paint. onlineSeat gates input to our colour's turns.
  function onlineStart({ seat, log = [] }) {
    epoch++;
    onlineSeat = seat;
    gameOverSent = false;
    aiPending = false;
    if (anim) { anim(); anim = null; }
    clearSelection();
    engine.reset();
    replayLog(log);
    layout();
    draw();
    refreshBanners();
  }

  function setOnlineReady() { refreshBanners(); } // ready-state changed → repaint banners/gating

  // Apply a peer's move (animated). The engine matches {from,path} to its own legal list, so a
  // desynced or illegal payload is ignored rather than corrupting the board.
  function applyRemoteMove(payload) {
    if (destroyed || !payload) return;
    const move = { from: payload.from, path: payload.path };
    clearSelection();
    animateMove(move, () => {
      const res = engine.move(move);
      if (res.ok) lastMove = { from: move.from, to: move.path[move.path.length - 1] };
      draw();
      refreshBanners();
    });
  }

  // Full re-sync (reconnect or mid-game join): rebuild the position from the authoritative log.
  function onlineResync(log = []) {
    if (anim) { anim(); anim = null; }
    clearSelection();
    engine.reset();
    replayLog(log);
    draw();
    refreshBanners();
  }

  // --- listeners --------------------------------------------------------------------------------
  canvas.addEventListener('mousedown', onPointerDown);
  canvas.addEventListener('touchstart', onPointerDown, { passive: false });

  layout();
  draw();

  return {
    newGame,
    setMode(mode) { if (mode !== 'online') newGame(); }, // online games start via onlineStart, not here
    setDifficulty() { /* takes effect on the AI's next search */ },
    undo,
    resize() { layout(); draw(); },

    // Online-play contract (see web/board.js + web/net.js).
    onlineStart,
    setOnlineReady,
    applyRemoteMove,
    onlineResync,

    // Shareable-position links (optional harness contract). getShareToken() encodes the current
    // position; loadShare() restores one and fully sets the view up (it is called INSTEAD of
    // newGame when board.js sees a ?state= token).
    getShareToken() { return engine.serialize(); },
    loadShare(token) {
      if (!engine.deserialize(token)) return false;
      epoch++;
      startView();
      return true;
    },
    destroy() {
      destroyed = true;
      epoch++;
      if (anim) anim();
      canvas.removeEventListener('mousedown', onPointerDown);
      canvas.removeEventListener('touchstart', onPointerDown);
    },
    rulesHtml: `
      <h4>Goal</h4>
      <ul><li>Capture all of your opponent's pieces, or leave them with no legal move.</li></ul>
      <h4>Controls</h4>
      <ul>
        <li>Tap one of your pieces to select it; green dots show where it can go.</li>
        <li>Tap a dot to move. Multi-jumps continue automatically; if the jump can branch, tap the next square.</li>
        <li><b>New game</b> restarts; <b>Undo</b> takes back your last move.</li>
      </ul>
      <h4>Rules (English draughts)</h4>
      <ul>
        <li>Men move one square diagonally forward and capture forward only, jumping an adjacent
            enemy to the empty square beyond.</li>
        <li><b>Captures are forced:</b> if you can take, you must ("You must take").</li>
        <li>Chained jumps must be completed in one turn.</li>
        <li>A man reaching the far row is <b>crowned</b> a king (♚) and can move and capture in any
            diagonal direction — but crowning <b>ends the move</b> immediately.</li>
      </ul>
      <p>You play Red (bottom). The computer plays White.</p>`,
  };
}
