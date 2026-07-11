// connect4.js — a pure, DOM-free Connect Four engine, in the same shape as the other board engines:
// createConnect4() → { reset, board, turn, legalMoves, move, status, aiMove, undo, history, serialize,
// deserialize }. Red moves first. A move is just a column {col}; the disc falls to the lowest empty row,
// so it replays deterministically for the online relay. Win = four in a row (any direction); a full
// board with no four is a draw.

const COLS = 7, ROWS = 6;          // board()[row][col], row 0 = BOTTOM
const other = (c) => (c === 'r' ? 'y' : 'r');
const CENTER_ORDER = [3, 2, 4, 1, 5, 0, 6]; // search centre-out: better move ordering + a saner AI

function freshBoard() { return Array.from({ length: ROWS }, () => new Array(COLS).fill(null)); }
function dropRow(g, col) { for (let r = 0; r < ROWS; r++) if (!g[r][col]) return r; return -1; } // -1 = full

// Does the disc at (r,c) complete a run of four? (Checks the four line orientations through it.)
function wins(g, r, c) {
  const color = g[r][c];
  if (!color) return false;
  for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
    let n = 1;
    for (const s of [1, -1]) {
      let rr = r + dr * s, cc = c + dc * s;
      while (rr >= 0 && rr < ROWS && cc >= 0 && cc < COLS && g[rr][cc] === color) { n++; rr += dr * s; cc += dc * s; }
    }
    if (n >= 4) return true;
  }
  return false;
}

// All length-4 windows (as coordinate lists), precomputed once for the evaluation heuristic.
const WINDOWS = (() => {
  const out = [];
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
      const er = r + 3 * dr, ec = c + 3 * dc;
      if (er < 0 || er >= ROWS || ec < 0 || ec >= COLS) continue;
      out.push([[r, c], [r + dr, c + dc], [r + 2 * dr, c + 2 * dc], [er, ec]]);
    }
  }
  return out;
})();

function evaluate(g, me) {
  const you = other(me);
  let score = 0;
  for (let r = 0; r < ROWS; r++) if (g[r][3] === me) score += 3; else if (g[r][3] === you) score -= 3; // centre bias
  for (const win of WINDOWS) {
    let m = 0, o = 0, e = 0;
    for (const [r, c] of win) { const v = g[r][c]; if (v === me) m++; else if (v === you) o++; else e++; }
    if (m && o) continue;                       // contested window — no potential for either
    if (m === 3 && e === 1) score += 50; else if (m === 2 && e === 2) score += 10;
    else if (o === 3 && e === 1) score -= 80;   // block the opponent's threats a bit more urgently
    else if (o === 2 && e === 2) score -= 10;
  }
  return score;
}

// Alpha-beta minimax on a mutable grid via drop/undrop (no per-node cloning). Fixed perspective `me`.
// A win is scored ±(large − ply) so the AI prefers the quickest win / slowest loss.
function search(g, toMove, me, depth, alpha, beta, ply) {
  const cols = CENTER_ORDER.filter((c) => dropRow(g, c) >= 0);
  if (!cols.length) return 0;                   // full board → draw
  if (depth === 0) return evaluate(g, me);
  const maximizing = toMove === me;
  let best = maximizing ? -Infinity : Infinity;
  for (const c of cols) {
    const r = dropRow(g, c);
    g[r][c] = toMove;
    let s;
    if (wins(g, r, c)) s = maximizing ? 100000 - ply : -100000 + ply;
    else s = search(g, other(toMove), me, depth - 1, alpha, beta, ply + 1);
    g[r][c] = null;
    if (maximizing) { best = Math.max(best, s); alpha = Math.max(alpha, best); }
    else { best = Math.min(best, s); beta = Math.min(beta, best); }
    if (alpha >= beta) break;
  }
  return best;
}

export function createConnect4() {
  let grid = freshBoard();
  let turn = 'r';                    // Red moves first
  let over = false, winner = null;   // winner: 'r' | 'y' | null (null while playing or on a draw)
  const stack = [];                  // { col, row, color } for undo

  const api = {
    reset() { grid = freshBoard(); turn = 'r'; over = false; winner = null; stack.length = 0; },
    board() { return grid.map((row) => row.slice()); },
    turn() { return turn; },
    legalMoves() { if (over) return []; const m = []; for (let c = 0; c < COLS; c++) if (dropRow(grid, c) >= 0) m.push(c); return m; },

    // Drop a disc in `col`; detect a win / draw; advance the turn otherwise.
    move({ col } = {}) {
      if (over || !Number.isInteger(col)) return { ok: false };
      const row = dropRow(grid, col);
      if (row < 0) return { ok: false };
      const color = turn;
      grid[row][col] = color;
      stack.push({ col, row, color });
      if (wins(grid, row, col)) { over = true; winner = color; }
      else if (stack.length === ROWS * COLS) { over = true; winner = null; }
      else turn = other(color);
      return { ok: true, row, col, turn };
    },

    status() {
      if (!over) return { over: false, winner: null, result: null, reason: '' };
      if (winner) return { over: true, winner, result: 'win', reason: `${winner === 'r' ? 'Red' : 'Yellow'} wins — four in a row` };
      return { over: true, winner: null, result: 'draw', reason: 'Board full — a draw' };
    },

    undo() {
      const last = stack.pop();
      if (!last) return false;
      grid[last.row][last.col] = null;
      over = false; winner = null;
      turn = last.color;
      return true;
    },
    history() { return stack.map((s) => ({ col: s.col })); },

    // Pick a column for the side to move. easy = shallow, hard = deep; tie-broken toward the centre
    // with a little randomness for variety. (Never used online — moves are relayed, not AI-derived.)
    aiMove(level = 'medium') {
      if (over) return null;
      const cols = api.legalMoves();
      if (!cols.length) return null;
      const me = turn;
      const depth = level === 'easy' ? 2 : level === 'hard' ? 7 : 5;
      const g = api.board();
      let bestScore = -Infinity;
      const scored = [];
      for (const c of CENTER_ORDER) {
        if (!cols.includes(c)) continue;
        const r = dropRow(g, c);
        g[r][c] = me;
        const s = wins(g, r, c) ? 1e6 : search(g, other(me), me, depth - 1, -Infinity, Infinity, 1);
        g[r][c] = null;
        scored.push({ c, s });
        if (s > bestScore) bestScore = s;
      }
      const best = scored.filter((x) => x.s === bestScore).map((x) => x.c);
      return { col: best[Math.floor(Math.random() * best.length)] };
    },

    // 42 cells (bottom row first, '.'/'r'/'y') + the side to move. `over`/`winner` are re-derived on load.
    serialize() {
      let s = '';
      for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) s += grid[r][c] || '.';
      return s + turn;
    },
    deserialize(token) {
      if (typeof token !== 'string' || token.length !== ROWS * COLS + 1) return false;
      const t = token[ROWS * COLS];
      if (t !== 'r' && t !== 'y') return false;
      const g = freshBoard();
      for (let i = 0; i < ROWS * COLS; i++) {
        const ch = token[i];
        if (ch === 'r' || ch === 'y') g[(i / COLS) | 0][i % COLS] = ch;
        else if (ch !== '.') return false;
      }
      grid = g; turn = t; stack.length = 0; over = false; winner = null;
      for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (g[r][c] && wins(g, r, c)) { over = true; winner = g[r][c]; }
      if (!over && g.every((row) => row.every((cell) => cell))) { over = true; winner = null; }
      return true;
    },
  };
  return api;
}

export default { createConnect4 };
