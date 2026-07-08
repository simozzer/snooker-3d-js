// games/chess-view.js — the Canvas 2D VIEW + input controller for chess. It owns nothing about the RULES
// (those live in src/board/chess.js); its whole job is to draw the board, translate clicks/taps into
// legal moves, animate the pieces, and drive the turn flow — including handing the position to the AI
// off the paint path so the UI never freezes while it thinks.
//
// It plugs into the shared board-game harness (web/board.js) via the mount(ctx) contract documented there:
// the harness supplies the canvas, the measuring box, the status/turn/result banners and the mode/
// difficulty getters; we return a small controller it can poke (newGame / undo / resize / destroy / …).

import { THEME, fitCanvas, pointerXY, animate, easeOut, think } from './board-common.js';
import { createChess } from '../../src/board/chess.js';

// Solid (filled) chess glyphs for BOTH colours — we colour them ourselves rather than relying on the
// font's hollow "white" set, which renders inconsistently across platforms. This gives us clean, uniform
// silhouettes we tint white or black and outline for contrast on either square colour.
const GLYPH = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };

const ANIM_MS = 160; // piece-slide duration; short enough to feel snappy, long enough to read the move

export default function mount(ctx) {
  const { canvas, box, ui, getMode, getDifficulty } = ctx;
  const engine = createChess();

  // --- view state -------------------------------------------------------------------------------------
  let mode = getMode();               // 'ai' | 'human'
  let difficulty = getDifficulty();   // 'easy' | 'medium' | 'hard'
  let dim = { w: 0, h: 0, ctx: null, sq: 0 }; // canvas metrics from fitCanvas (+ derived square size)

  let selected = null;   // {file,rank} of the picked-up piece, or null
  let legal = [];        // cached legal destinations for `selected` (public move objects)
  let lastMove = null;   // {from,to} of the most recent move, for the trailing highlight
  let over = false;      // game finished — input is frozen until New game / Undo
  let anim = null;       // active slide animation, or null; { glyph, white, x, y, hideTo }
  let stopAnim = null;   // canceller for the animate() rAF loop
  let thinking = false;  // AI is mid-search (input frozen, "thinking…" prompt shown)
  let aiToken = 0;       // bumped on any interruption (undo/newGame/mode change) to void a stale AI reply

  // ---------------------------------------------------------------------------------------------------
  // Geometry: engine board()[rank][file] has rank 0 = rank 1. We draw White at the BOTTOM, so screen row
  // 0 (top) is rank 8 and screen row 7 (bottom) is rank 1 → screenRow = 7 - rank, screenCol = file.
  // ---------------------------------------------------------------------------------------------------
  const cellX = (file) => file * dim.sq;
  const cellY = (rank) => (7 - rank) * dim.sq;
  const centerX = (file) => cellX(file) + dim.sq / 2;
  const centerY = (rank) => cellY(rank) + dim.sq / 2;

  function squareAt(px, py) {
    const file = Math.floor(px / dim.sq);
    const rank = 7 - Math.floor(py / dim.sq);
    if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
    return { file, rank };
  }

  // ---------------------------------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------------------------------
  function render() {
    const c = dim.ctx;
    if (!c) return;
    const sq = dim.sq;
    const grid = engine.board();
    const inCheck = engine.inCheck();
    const sideToMove = engine.turn();

    // 1) Squares + coordinate labels.
    for (let rank = 0; rank < 8; rank++) {
      for (let file = 0; file < 8; file++) {
        const dark = (file + rank) % 2 === 0; // a1 (file 0, rank 0) is dark
        c.fillStyle = dark ? THEME.sqDark : THEME.sqLight;
        c.fillRect(cellX(file), cellY(rank), sq, sq);
      }
    }

    // 2) Move + state highlights (under the pieces).
    if (lastMove) { fillSquare(c, lastMove.from, THEME.lastMove); fillSquare(c, lastMove.to, THEME.lastMove); }
    if (inCheck) {
      const k = findKing(grid, sideToMove);
      if (k) fillSquare(c, k, THEME.check);
    }
    if (selected) fillSquare(c, selected, THEME.selected);

    // 3) Coordinate labels — files along the bottom row, ranks up the left column, tucked in a corner and
    //    tinted with the opposite square colour so they stay legible on wood.
    drawCoordinates(c);

    // 4) Pieces (skipping the one currently sliding).
    for (let rank = 0; rank < 8; rank++) {
      for (let file = 0; file < 8; file++) {
        const p = grid[rank][file];
        if (!p) continue;
        if (anim && anim.hideTo && anim.hideTo.file === file && anim.hideTo.rank === rank) continue;
        drawPiece(c, GLYPH[p.type], p.color === 'w', centerX(file), centerY(rank));
      }
    }

    // 5) Legal-move hints for the selected piece (on top of pieces so captures read clearly).
    if (selected) {
      for (const m of legal) {
        const target = grid[m.to.rank][m.to.file];
        const cx = centerX(m.to.file), cy = centerY(m.to.rank);
        if (target) {
          // Capture: a ring hugging the square edge.
          c.beginPath();
          c.arc(cx, cy, sq * 0.44, 0, Math.PI * 2);
          c.lineWidth = Math.max(2, sq * 0.06);
          c.strokeStyle = THEME.legal;
          c.stroke();
        } else {
          // Quiet move: a centred dot.
          c.beginPath();
          c.arc(cx, cy, sq * 0.16, 0, Math.PI * 2);
          c.fillStyle = THEME.legal;
          c.fill();
        }
      }
    }

    // 6) The sliding piece, painted last so it floats above everything.
    if (anim) drawPiece(c, anim.glyph, anim.white, anim.x, anim.y);
  }

  function fillSquare(c, { file, rank }, color) {
    c.fillStyle = color;
    c.fillRect(cellX(file), cellY(rank), dim.sq, dim.sq);
  }

  function drawPiece(c, glyph, white, x, y) {
    const sq = dim.sq;
    c.save();
    c.font = `${Math.round(sq * 0.74)}px "Segoe UI Symbol", "Noto Sans Symbols2", "Apple Symbols", sans-serif`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    // Soft drop shadow lifts the piece off the board.
    c.shadowColor = 'rgba(0,0,0,0.35)';
    c.shadowBlur = sq * 0.05;
    c.shadowOffsetY = sq * 0.03;
    c.fillStyle = white ? '#f7f4ec' : '#26262b';
    c.fillText(glyph, x, y);
    // Outline in the opposite tone so each colour is crisp on either square shade.
    c.shadowColor = 'transparent';
    c.lineWidth = Math.max(1, sq * 0.018);
    c.strokeStyle = white ? '#3a2c1d' : '#e6d8bd';
    c.strokeText(glyph, x, y);
    c.restore();
  }

  function drawCoordinates(c) {
    const sq = dim.sq;
    c.save();
    c.font = `${Math.round(sq * 0.16)}px system-ui, sans-serif`;
    c.textBaseline = 'top';
    for (let file = 0; file < 8; file++) {
      const dark = (file + 0) % 2 === 0; // rank 1 row parity for the label colour
      c.fillStyle = dark ? THEME.sqLight : THEME.sqDark;
      c.textAlign = 'right';
      c.fillText('abcdefgh'[file], cellX(file) + sq - sq * 0.06, cellY(0) + sq - sq * 0.2);
    }
    c.textAlign = 'left';
    c.textBaseline = 'top';
    for (let rank = 0; rank < 8; rank++) {
      const dark = (0 + rank) % 2 === 0; // file a column parity
      c.fillStyle = dark ? THEME.sqLight : THEME.sqDark;
      c.fillText(String(rank + 1), cellX(0) + sq * 0.06, cellY(rank) + sq * 0.06);
    }
    c.restore();
  }

  function findKing(grid, color) {
    for (let rank = 0; rank < 8; rank++)
      for (let file = 0; file < 8; file++) {
        const p = grid[rank][file];
        if (p && p.type === 'k' && p.color === color) return { file, rank };
      }
    return null;
  }

  // ---------------------------------------------------------------------------------------------------
  // Turn flow
  // ---------------------------------------------------------------------------------------------------
  function promptTurn() {
    if (over) { ui.turn(null); return; }
    const t = engine.turn();
    const check = engine.inCheck() ? ' — Check!' : '';
    if (mode === 'ai') {
      ui.turn(t === 'w' ? `Your move (White)${check}` : 'AI is thinking…');
    } else {
      ui.turn(`${t === 'w' ? 'White' : 'Black'} to move${check}`);
    }
  }

  // Whether a human is allowed to touch the board right now.
  function humanToMove() {
    if (over || thinking || anim) return false;
    if (mode === 'human') return true;
    return engine.turn() === 'w'; // in AI mode the human is always White
  }

  // Apply a validated public move, animate it, then advance the game.
  function applyMove(m) {
    const res = engine.move(m);
    if (!res.ok) return false;
    selected = null; legal = [];
    lastMove = { from: m.from, to: m.to };
    ui.status('');
    ui.setUndo(true);
    animateMove(m.from, m.to, afterMove);
    return true;
  }

  function afterMove() {
    const st = engine.status();
    if (st.over) {
      over = true;
      render();
      ui.turn(null);
      ui.result(st.reason || 'Game over');
      return;
    }
    render();
    promptTurn();
    // Hand off to the AI when it's Black's turn in AI mode.
    if (mode === 'ai' && engine.turn() === 'b') scheduleAI();
  }

  function scheduleAI() {
    thinking = true;
    promptTurn(); // shows "AI is thinking…"
    const token = aiToken;
    // think() defers the (synchronous) search so this move paints first and the prompt shows.
    think(() => engine.aiMove(difficulty), (m) => {
      if (token !== aiToken) return; // an undo / new game / mode change happened while we searched
      thinking = false;
      if (!m) { afterMove(); return; } // no legal move (mate/stalemate already handled by status)
      applyMove(m);
    });
  }

  // ---------------------------------------------------------------------------------------------------
  // Animation
  // ---------------------------------------------------------------------------------------------------
  function animateMove(from, to, done) {
    cancelAnim();
    const grid = engine.board();
    const p = grid[to.rank][to.file]; // the piece now sitting on the destination (post-move)
    if (!p) { done(); return; }       // nothing to animate (shouldn't happen) — just continue
    anim = { glyph: GLYPH[p.type], white: p.color === 'w', x: centerX(from.file), y: centerY(from.rank),
             hideTo: to };
    const x0 = centerX(from.file), y0 = centerY(from.rank);
    const x1 = centerX(to.file), y1 = centerY(to.rank);
    stopAnim = animate((elapsed) => {
      const k = easeOut(elapsed / ANIM_MS);
      anim.x = x0 + (x1 - x0) * k;
      anim.y = y0 + (y1 - y0) * k;
      render();
      if (elapsed >= ANIM_MS) { anim = null; stopAnim = null; render(); done(); return false; }
      return true;
    });
  }

  function cancelAnim() {
    if (stopAnim) { stopAnim(); stopAnim = null; }
    anim = null;
  }

  // ---------------------------------------------------------------------------------------------------
  // Input
  // ---------------------------------------------------------------------------------------------------
  function onPointerDown(ev) {
    if (!humanToMove()) return;
    ev.preventDefault();
    const { x, y } = pointerXY(canvas, ev);
    const sq = squareAt(x, y);
    if (!sq) return;
    const grid = engine.board();
    const piece = grid[sq.rank][sq.file];
    const myColor = engine.turn();

    if (selected) {
      // Second click: play it if it's a legal destination.
      const target = legal.find((m) => m.to.file === sq.file && m.to.rank === sq.rank);
      if (target) { applyMove({ from: selected, to: sq, promotion: 'q' }); return; }
      // Clicking another of your own pieces re-selects; anything else clears.
      if (piece && piece.color === myColor) { select(sq); } else { selected = null; legal = []; render(); }
      return;
    }

    // First click: pick up one of your own pieces that actually has a move.
    if (piece && piece.color === myColor) select(sq);
  }

  function select(sq) {
    const moves = engine.legalMovesFrom(sq);
    if (moves.length === 0) { selected = null; legal = []; render(); return; }
    selected = sq; legal = moves;
    render();
  }

  // ---------------------------------------------------------------------------------------------------
  // Sizing
  // ---------------------------------------------------------------------------------------------------
  function resize() {
    const fit = fitCanvas(canvas, box, { square: true });
    dim = { w: fit.w, h: fit.h, ctx: fit.ctx, sq: fit.w / 8 };
    render();
  }

  // ---------------------------------------------------------------------------------------------------
  // Controller (the surface web/board.js drives)
  // ---------------------------------------------------------------------------------------------------
  function newGame() {
    aiToken++;              // void any in-flight AI search
    engine.reset();
    lastMove = null;        // fresh game — no previous move to highlight
    startFromPosition();
  }

  // Shared view init used by BOTH newGame() and loadShare(): once the engine holds the desired position,
  // this fits the canvas, paints, syncs the prompt/undo/result, and lets the AI move if it's on turn.
  // (The pointer listener is attached once at mount, so it's already live for either entry point.)
  function startFromPosition() {
    cancelAnim();
    thinking = false;
    selected = null; legal = [];
    over = false;
    mode = getMode(); difficulty = getDifficulty();
    ui.result(null); ui.status('');
    resize();                                   // (re)fit + first paint
    ui.setUndo(engine.history().length > 0);    // a loaded FEN has no history → nothing to undo
    const st = engine.status();
    if (st.over) {                              // sharing/loading an already-finished position is allowed
      over = true;
      ui.turn(null);
      ui.result(st.reason || 'Game over');
      return;
    }
    promptTurn();
    // If the shared position has Black (the AI) to move in AI mode, let it think — mirrors normal play.
    if (mode === 'ai' && engine.turn() === 'b') scheduleAI();
  }

  // --- shareable position links (optional harness contract) -------------------------------------------
  // getShareToken(): a FEN snapshot of the CURRENT position (its spaces are percent-encoded by the
  // harness). Finished games are shareable too. loadShare(token): restore the game from such a token.
  function getShareToken() {
    return engine.fen();
  }

  function loadShare(token) {
    if (!engine.loadFEN(token)) return false;   // reject a malformed/foreign token, leaving state untouched
    aiToken++;                                   // void any in-flight AI search from the prior position
    lastMove = null;                             // a FEN carries no move history
    startFromPosition();
    return true;
  }

  function setMode(next) {
    mode = next;
    newGame(); // start fresh so we never sit in a half-played mismatch between the two modes
  }

  function setDifficulty(next) {
    difficulty = next; // applies from the AI's next move; no need to disturb the current position
  }

  function undo() {
    cancelAnim();
    aiToken++;          // cancel a pending AI reply if one is mid-flight
    thinking = false;
    if (mode === 'ai') {
      // Return control to the human (White): drop the AI's reply + our move, or just our move if the AI
      // hasn't answered yet (e.g. our move ended the game).
      if (engine.turn() === 'w' && engine.history().length >= 2) { engine.undo(); engine.undo(); }
      else if (engine.history().length >= 1) { engine.undo(); }
    } else if (engine.history().length >= 1) {
      engine.undo();
    }
    over = false;
    selected = null; legal = [];
    const hist = engine.history();
    lastMove = hist.length ? hist[hist.length - 1] : null;
    ui.result(null);
    ui.setUndo(hist.length > 0);
    render();
    promptTurn();
  }

  function destroy() {
    cancelAnim();
    aiToken++;
    canvas.removeEventListener('pointerdown', onPointerDown);
  }

  canvas.addEventListener('pointerdown', onPointerDown);

  const rulesHtml = `
    <h4>Controls</h4>
    <ul>
      <li>Tap a piece to pick it up — its legal moves show as dots (captures as rings).</li>
      <li>Tap a highlighted square to move there; tap another of your pieces to switch.</li>
      <li>The last move is shaded gold; a king in check flashes red.</li>
      <li><b>New game</b> restarts; <b>Undo</b> takes back your last move (and the AI's reply).</li>
    </ul>
    <h4>Modes</h4>
    <ul>
      <li><b>You vs AI</b> — you play <b>White</b> (bottom) and move first; the AI plays Black. Pick Easy, Medium or Hard.</li>
      <li><b>Two players</b> — hot-seat; the board prompts each side in turn.</li>
    </ul>
    <h4>The rules in brief</h4>
    <ul>
      <li>Pawns step forward (two from their start), capture diagonally, and can capture <i>en passant</i>.</li>
      <li>Knights leap in an L; bishops go diagonally; rooks straight; the queen any line; the king one square.</li>
      <li><b>Castling</b>: king and rook jump together if neither has moved, the path is clear, and the king isn't (or doesn't move through) check.</li>
      <li>A pawn reaching the far rank promotes — this game auto-queens.</li>
      <li>Trap the enemy king with no escape for <b>checkmate</b>. No legal move while <i>not</i> in check is <b>stalemate</b> (a draw).</li>
      <li>Draws also come from insufficient material, the 50-move rule, or threefold repetition.</li>
    </ul>`;

  return { newGame, setMode, setDifficulty, undo, resize, destroy, getShareToken, loadShare, rulesHtml };
}
