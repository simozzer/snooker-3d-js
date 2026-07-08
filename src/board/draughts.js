// draughts.js — English (American) draughts / checkers ENGINE + AI.
//
// Pure, DOM-free game module for the board-games shell (see web/board.js). Runs identically in the
// browser and in Node (the test suite imports it directly), with no dependencies. The view layer
// (web/games/draughts-view.js) owns all rendering and input; this file owns nothing but the rules,
// the move generator, and a minimax/alpha-beta opponent.
//
// ---- BOARD ORIENTATION -----------------------------------------------------------------------
// board() is an 8x8 array indexed [row][col], row 0 at the TOP, row 7 at the BOTTOM.
// Play happens only on the 32 dark squares, defined here as (row + col) odd.
//   • 'w' (white) starts on rows 0..2 (the top) and moves DOWN  (row increasing). Crowns on row 7.
//   • 'r' (red/black) starts on rows 5..7 (the bottom) and moves UP (row decreasing). Crowns on row 0.
// Red moves first, matching standard draughts. In the AI view the human is 'r' (bottom).
// Each occupied cell is { color: 'r' | 'w', king: boolean }; empty (or non-playable) cells are null.
//
// ---- RULES (English draughts) ----------------------------------------------------------------
//   • Men step one square diagonally FORWARD to an empty square.
//   • Men CAPTURE forward only, by jumping an adjacent diagonally-forward enemy to the empty square
//     beyond it. Kings move and capture one square diagonally in ANY direction.
//   • FORCED CAPTURE: if any capture exists for the side to move, some capture must be played (any
//     legal capture — no forced-longest-line requirement, no huffing).
//   • MULTI-JUMP: after a capture the SAME piece must keep jumping while it still can, in one turn.
//   • CROWNING: a man reaching the far back rank becomes a king and its move ENDS immediately — it
//     cannot continue jumping as a king on the same turn.
//   • A side that cannot move (no pieces, or all pieces blocked) LOSES. A 40-move-per-side run with
//     no capture and no crowning is declared a draw.

// Diagonal directions as [dRow, dCol].
const DIRS = {
  r: [[-1, -1], [-1, 1]],          // red men: forward = up
  w: [[1, -1], [1, 1]],            // white men: forward = down
  king: [[-1, -1], [-1, 1], [1, -1], [1, 1]],
};
const CROWN_ROW = { r: 0, w: 7 };  // a man crowns on reaching this row
const BACK_ROW = { r: 7, w: 0 };   // a side's own back rank (defended in the eval)
const DRAW_PLIES = 80;             // 40 moves each side with no capture / no crown => draw

const inBounds = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;
const isDark = (r, c) => ((r + c) & 1) === 1;
const other = (color) => (color === 'r' ? 'w' : 'r');
const sameSq = (a, b) => a && b && a.row === b.row && a.col === b.col;

function cloneGrid(grid) {
  const g = new Array(8);
  for (let r = 0; r < 8; r++) {
    g[r] = new Array(8);
    for (let c = 0; c < 8; c++) {
      const p = grid[r][c];
      g[r][c] = p ? { color: p.color, king: p.king } : null;
    }
  }
  return g;
}

function initialGrid() {
  const g = Array.from({ length: 8 }, () => new Array(8).fill(null));
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if (!isDark(r, c)) continue;
      if (r <= 2) g[r][c] = { color: 'w', king: false };
      else if (r >= 5) g[r][c] = { color: 'r', king: false };
    }
  }
  return g;
}

// ---- Move generation -------------------------------------------------------------------------
// A move = { from:{row,col}, path:[{row,col}, ...], captures:[{row,col}, ...], crown:boolean }.
// `path` lists every landing square in order (one entry for a step, several for a multi-jump);
// the final entry is where the piece ends up.

function dirsFor(piece) {
  return piece.king ? DIRS.king : DIRS[piece.color];
}

// All capture sequences for one piece sitting at (row,col) on `grid`. Recurses on a working copy
// with each jumped piece removed so a man is never leapt twice in the same chain.
function pieceCaptures(grid, row, col) {
  const piece = grid[row][col];
  const out = [];
  const recurse = (g, r, c, path, caps) => {
    const p = g[r][c];
    let extended = false;
    for (const [dr, dc] of dirsFor(p)) {
      const mr = r + dr, mc = c + dc;         // square being jumped
      const lr = r + 2 * dr, lc = c + 2 * dc; // landing square
      if (!inBounds(lr, lc)) continue;
      const victim = g[mr][mc];
      if (!victim || victim.color === p.color) continue;
      if (g[lr][lc]) continue;                // must land on an empty square
      const crown = !p.king && lr === CROWN_ROW[p.color];
      const ng = cloneGrid(g);
      ng[r][c] = null;
      ng[mr][mc] = null;
      ng[lr][lc] = { color: p.color, king: p.king || crown };
      const npath = [...path, { row: lr, col: lc }];
      const ncaps = [...caps, { row: mr, col: mc }];
      // Crowning ends the move immediately — no chaining as a fresh king.
      if (crown) {
        out.push({ from: { row, col }, path: npath, captures: ncaps, crown: true });
        extended = true;
        continue;
      }
      const before = out.length;
      recurse(ng, lr, lc, npath, ncaps);
      if (out.length === before) {
        // No further jump from here: this chain terminates.
        out.push({ from: { row, col }, path: npath, captures: ncaps, crown: false });
      }
      extended = true;
    }
    return extended;
  };
  recurse(grid, row, col, [], []);
  return out;
}

// Single-step (non-capturing) moves for one piece.
function pieceQuiets(grid, row, col) {
  const piece = grid[row][col];
  const out = [];
  for (const [dr, dc] of dirsFor(piece)) {
    const r = row + dr, c = col + dc;
    if (!inBounds(r, c) || grid[r][c]) continue;
    const crown = !piece.king && r === CROWN_ROW[piece.color];
    out.push({ from: { row, col }, path: [{ row: r, col: c }], captures: [], crown });
  }
  return out;
}

// Every legal move for `color`, honouring the forced-capture rule (captures only, if any exist).
function generateMoves(grid, color) {
  const captures = [];
  const quiets = [];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = grid[r][c];
      if (!p || p.color !== color) continue;
      const caps = pieceCaptures(grid, r, c);
      if (caps.length) captures.push(...caps);
      else quiets.push(...pieceQuiets(grid, r, c));
    }
  }
  return captures.length ? captures : quiets;
}

// Apply a fully-specified move to a cloned grid; returns { grid, crowned }.
function applyToGrid(grid, move) {
  const g = cloneGrid(grid);
  const from = move.from;
  const piece = g[from.row][from.col];
  g[from.row][from.col] = null;
  for (const cap of move.captures) g[cap.row][cap.col] = null;
  const dest = move.path[move.path.length - 1];
  const crowned = !piece.king && dest.row === CROWN_ROW[piece.color];
  g[dest.row][dest.col] = { color: piece.color, king: piece.king || crowned };
  return { g, crowned };
}

function countPieces(grid) {
  let r = 0, w = 0;
  for (let row = 0; row < 8; row++)
    for (let col = 0; col < 8; col++) {
      const p = grid[row][col];
      if (p) (p.color === 'r' ? r++ : w++);
    }
  return { r, w };
}

const FILE = 'abcdefgh';
const sqName = (s) => `${FILE[s.col]}${8 - s.row}`;

// ---- AI: static evaluation + negamax/alpha-beta ----------------------------------------------
const V = {
  MAN: 100, KING: 160,
  ADVANCE: 3,   // per row a man has advanced toward its crown row
  BACK: 8,      // man still guarding its own back rank
  CENTER: 4,    // man on a central file (cols 2..5)
  KCENTER: 6,   // king on the central 4x4
  MOBILITY: 2,  // per available move
  WIN: 1e6,
};

// Evaluate `grid` from `side`'s point of view (higher = better for `side`).
function evaluate(grid, side) {
  let score = 0;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = grid[r][c];
      if (!p) continue;
      let v = p.king ? V.KING : V.MAN;
      if (p.king) {
        if (r >= 2 && r <= 5 && c >= 2 && c <= 5) v += V.KCENTER;
      } else {
        const advanced = p.color === 'r' ? 7 - r : r;   // rows moved toward crown
        v += advanced * V.ADVANCE;
        if (r === BACK_ROW[p.color]) v += V.BACK;
        if (c >= 2 && c <= 5) v += V.CENTER;
      }
      score += p.color === side ? v : -v;
    }
  }
  score += V.MOBILITY * (generateMoves(grid, side).length - generateMoves(grid, other(side)).length);
  return score;
}

// Order captures before quiet moves (and longer captures first) to sharpen alpha-beta pruning.
function orderMoves(moves) {
  return moves.slice().sort((a, b) => b.captures.length - a.captures.length);
}

function negamax(grid, color, depth, alpha, beta, ctx) {
  if (Date.now() > ctx.deadline) { ctx.aborted = true; return 0; }
  const moves = generateMoves(grid, color);
  if (moves.length === 0) return -(V.WIN + depth); // side to move has lost; prefer to lose later
  if (depth === 0) return evaluate(grid, color);
  let best = -Infinity;
  for (const m of orderMoves(moves)) {
    const { g } = applyToGrid(grid, m);
    const score = -negamax(g, other(color), depth - 1, -beta, -alpha, ctx);
    if (ctx.aborted) return 0;
    if (score > best) best = score;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

// Search the root to a fixed depth; returns the best move plus whether the search completed.
function rootSearch(grid, color, depth, deadline, preferred) {
  const ctx = { deadline, aborted: false };
  let moves = orderMoves(generateMoves(grid, color));
  if (preferred) { // try last iteration's best first for a tighter window
    moves = moves.slice().sort((a, b) =>
      (sameMove(b, preferred) ? 1 : 0) - (sameMove(a, preferred) ? 1 : 0));
  }
  let best = moves[0] || null;
  let bestScore = -Infinity;
  let alpha = -Infinity;
  for (const m of moves) {
    const { g } = applyToGrid(grid, m);
    const score = -negamax(g, other(color), depth - 1, -Infinity, -alpha, ctx);
    if (ctx.aborted) return { move: best, done: false };
    if (score > bestScore) { bestScore = score; best = m; }
    if (score > alpha) alpha = score;
  }
  return { move: best, done: true };
}

function sameMove(a, b) {
  if (!a || !b) return false;
  const ad = a.path[a.path.length - 1], bd = b.path[b.path.length - 1];
  return sameSq(a.from, b.from) && sameSq(ad, bd) && a.captures.length === b.captures.length;
}

// ---- Public factory --------------------------------------------------------------------------
export function createDraughts() {
  let grid = initialGrid();
  let turn = 'r';
  let noProgress = 0;               // plies since the last capture or crowning
  const undoStack = [];            // snapshots for undo()
  const moveLog = [];              // applied-move records for history()

  function snapshot() {
    return { grid: cloneGrid(grid), turn, noProgress };
  }
  function restore(s) {
    grid = cloneGrid(s.grid); turn = s.turn; noProgress = s.noProgress;
  }

  // Match a caller-supplied move against the legal list (from + final square + capture count).
  function findLegal(m) {
    if (!m || !m.from || !m.path || !m.path.length) return null;
    const dest = m.path[m.path.length - 1];
    const legal = generateMoves(grid, turn);
    const matches = legal.filter((lm) =>
      sameSq(lm.from, m.from) &&
      sameSq(lm.path[lm.path.length - 1], dest) &&
      lm.captures.length === (m.captures ? m.captures.length : lm.captures.length));
    if (matches.length <= 1) return matches[0] || null;
    // Disambiguate rare same-destination chains by comparing the full capture set.
    if (m.captures) {
      const key = (arr) => arr.map((s) => `${s.row},${s.col}`).sort().join('|');
      return matches.find((lm) => key(lm.captures) === key(m.captures)) || matches[0];
    }
    return matches[0];
  }

  const api = {
    reset() {
      grid = initialGrid(); turn = 'r'; noProgress = 0;
      undoStack.length = 0; moveLog.length = 0;
      return api;
    },

    // Load a custom position (mainly for tests). `spec` is an 8x8 array of characters:
    // 'r'/'w' men, 'R'/'W' kings, anything else = empty. `turnColor` is 'r' or 'w'.
    load(spec, turnColor = 'r') {
      grid = Array.from({ length: 8 }, () => new Array(8).fill(null));
      for (let r = 0; r < 8; r++) {
        const row = spec[r] || [];
        for (let c = 0; c < 8; c++) {
          const ch = typeof row === 'string' ? row[c] : row[c];
          if (ch === 'r') grid[r][c] = { color: 'r', king: false };
          else if (ch === 'w') grid[r][c] = { color: 'w', king: false };
          else if (ch === 'R') grid[r][c] = { color: 'r', king: true };
          else if (ch === 'W') grid[r][c] = { color: 'w', king: true };
        }
      }
      turn = turnColor; noProgress = 0;
      undoStack.length = 0; moveLog.length = 0;
      return api;
    },

    board() { return cloneGrid(grid); },
    turn() { return turn; },

    // Legal moves originating from a given square, honouring forced capture.
    legalMovesFrom(square) {
      if (!square) return [];
      return generateMoves(grid, turn).filter((m) => sameSq(m.from, square));
    },

    allLegalMoves() { return generateMoves(grid, turn); },

    move(m) {
      if (api.status().over) return { ok: false, captures: [], crowned: false };
      const legal = findLegal(m);
      if (!legal) return { ok: false, captures: [], crowned: false };
      undoStack.push(snapshot());
      const { g, crowned } = applyToGrid(grid, legal);
      grid = g;
      const captured = legal.captures.length;
      noProgress = (captured > 0 || crowned) ? 0 : noProgress + 1;
      moveLog.push({
        color: turn, from: legal.from, to: legal.path[legal.path.length - 1],
        path: legal.path, captures: legal.captures, crowned,
        notation: `${sqName(legal.from)}${captured ? 'x' : '-'}${sqName(legal.path[legal.path.length - 1])}${crowned ? '=K' : ''}`,
      });
      turn = other(turn);
      return { ok: true, captures: legal.captures.slice(), crowned };
    },

    status() {
      const cnt = countPieces(grid);
      if (cnt.r === 0) return { over: true, winner: 'w', result: 'win', reason: 'no pieces' };
      if (cnt.w === 0) return { over: true, winner: 'r', result: 'win', reason: 'no pieces' };
      if (generateMoves(grid, turn).length === 0)
        return { over: true, winner: other(turn), result: 'win', reason: 'no moves' };
      if (noProgress >= DRAW_PLIES)
        return { over: true, winner: null, result: 'draw', reason: '40-move rule' };
      return { over: false, winner: null, result: null, reason: null };
    },

    // A good move for the side to move (NOT applied). level: 'easy' | 'medium' | 'hard'.
    aiMove(level = 'medium') {
      const moves = generateMoves(grid, turn);
      if (moves.length === 0) return null;
      if (moves.length === 1) return moves[0];

      if (level === 'easy') {
        // Shallow and a bit random for a beginner-friendly opponent.
        if (Math.random() < 0.35) return moves[Math.floor(Math.random() * moves.length)];
        return rootSearch(grid, turn, 1, Date.now() + 200).move;
      }

      const maxDepth = level === 'hard' ? 10 : 4;
      const deadline = Date.now() + (level === 'hard' ? 900 : 500);
      let best = moves[0];
      for (let d = 1; d <= maxDepth; d++) {
        const res = rootSearch(grid, turn, d, deadline, best);
        if (res.done && res.move) best = res.move;
        if (!res.done || Date.now() > deadline) break;
      }
      return best;
    },

    undo() {
      if (!undoStack.length) return false;
      restore(undoStack.pop());
      moveLog.pop();
      return true;
    },

    history() { return moveLog.map((m) => ({ ...m })); },

    // --- shareable-position codec -------------------------------------------------------------
    // serialize() -> a compact, URL-safe token capturing everything needed to resume: the 32
    // playable squares (row-major dark-square order), the side to move, and the draw counter.
    // Layout: 32 cell chars over the alphabet ".rRwW" + one turn char ("r"/"w") + the draw
    // counter as decimal digits. Every character is URL-unreserved, so no extra encoding is needed.
    serialize() {
      let cells = '';
      for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
          if (!isDark(r, c)) continue;
          cells += CELL_CHAR(grid[r][c]);
        }
      }
      return `${cells}${turn}${noProgress}`;
    },

    // deserialize(token) -> true if `token` is a valid position (restored into this engine),
    // false for anything malformed. Rejects wrong length, stray characters, or a bad counter.
    deserialize(token) {
      if (typeof token !== 'string' || token.length < 34) return false;
      const cells = token.slice(0, 32);
      const turnCh = token[32];
      const counterStr = token.slice(33);
      if (!/^[.rRwW]{32}$/.test(cells)) return false;
      if (turnCh !== 'r' && turnCh !== 'w') return false;
      if (!/^\d+$/.test(counterStr)) return false;
      const counter = Number(counterStr);
      if (!Number.isSafeInteger(counter)) return false;

      const g = Array.from({ length: 8 }, () => new Array(8).fill(null));
      let i = 0;
      for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
          if (!isDark(r, c)) continue;
          g[r][c] = CHAR_CELL(cells[i++]);
        }
      }
      grid = g; turn = turnCh; noProgress = counter;
      undoStack.length = 0; moveLog.length = 0;
      return true;
    },
  };

  return api;
}

// Piece <-> single character used by the share codec.
function CELL_CHAR(p) {
  if (!p) return '.';
  return p.king ? (p.color === 'r' ? 'R' : 'W') : (p.color === 'r' ? 'r' : 'w');
}
function CHAR_CELL(ch) {
  switch (ch) {
    case 'r': return { color: 'r', king: false };
    case 'R': return { color: 'r', king: true };
    case 'w': return { color: 'w', king: false };
    case 'W': return { color: 'w', king: true };
    default: return null;
  }
}

export default createDraughts;
