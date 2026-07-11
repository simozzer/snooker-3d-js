// othello.js — a pure, DOM-free Reversi/Othello engine, in the same shape as the other board engines
// (chess/draughts): createOthello() returns { reset, board, turn, legalMoves, move, status, aiMove,
// undo, history, serialize, deserialize }. Black moves first. All state is a plain 8×8 grid of
// 'b' | 'w' | null, so a move ({r,c}) replays deterministically — which is what the online relay needs.
//
// A move is legal only if it flanks at least one unbroken line of opponent discs bounded by one of your
// own; every flanked disc flips. If the player to move has NO legal move they PASS automatically (the
// engine advances the turn for them); when NEITHER side can move the game is over and the majority wins.
// Passing is handled inside move() so it's deterministic on every client — no separate "pass" message.

const SIZE = 8;
const DIRS = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
const other = (c) => (c === 'b' ? 'w' : 'b');
const inb = (r, c) => r >= 0 && r < SIZE && c >= 0 && c < SIZE;

function freshBoard() {
  const g = Array.from({ length: SIZE }, () => new Array(SIZE).fill(null));
  g[3][3] = 'w'; g[3][4] = 'b'; g[4][3] = 'b'; g[4][4] = 'w'; // standard opening
  return g;
}

// The discs that placing `color` at (r,c) would flip — empty if the move is illegal (occupied / flips none).
function flipsFor(g, r, c, color) {
  if (g[r][c]) return [];
  const out = [];
  for (const [dr, dc] of DIRS) {
    const line = [];
    let rr = r + dr, cc = c + dc;
    while (inb(rr, cc) && g[rr][cc] === other(color)) { line.push([rr, cc]); rr += dr; cc += dc; }
    if (line.length && inb(rr, cc) && g[rr][cc] === color) out.push(...line);
  }
  return out;
}

function legalFor(g, color) {
  const moves = [];
  for (let r = 0; r < SIZE; r++)
    for (let c = 0; c < SIZE; c++)
      if (!g[r][c] && flipsFor(g, r, c, color).length) moves.push({ r, c });
  return moves;
}

function counts(g) {
  let b = 0, w = 0;
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) { if (g[r][c] === 'b') b++; else if (g[r][c] === 'w') w++; }
  return { b, w };
}

// Return a NEW grid with `color` placed at (r,c) and all flanked discs flipped (assumes legality).
function applied(g, r, c, color) {
  const ng = g.map((row) => row.slice());
  ng[r][c] = color;
  for (const [fr, fc] of flipsFor(g, r, c, color)) ng[fr][fc] = color;
  return ng;
}

// Positional weights for the AI: corners are gold, the squares next to them (C/X-squares) are traps.
const WEIGHTS = [
  [120, -20, 20, 5, 5, 20, -20, 120],
  [-20, -40, -5, -5, -5, -5, -40, -20],
  [20, -5, 15, 3, 3, 15, -5, 20],
  [5, -5, 3, 3, 3, 3, -5, 5],
  [5, -5, 3, 3, 3, 3, -5, 5],
  [20, -5, 15, 3, 3, 15, -5, 20],
  [-20, -40, -5, -5, -5, -5, -40, -20],
  [120, -20, 20, 5, 5, 20, -20, 120],
];
// Try corners first — better alpha-beta pruning.
const cornerFirst = (moves) => moves.slice().sort((a, b) => WEIGHTS[b.r][b.c] - WEIGHTS[a.r][a.c]);

function evalGrid(g, me) {
  const you = other(me);
  const cnt = counts(g);
  let pos = 0;
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
    if (g[r][c] === me) pos += WEIGHTS[r][c]; else if (g[r][c] === you) pos -= WEIGHTS[r][c];
  }
  const mob = 8 * (legalFor(g, me).length - legalFor(g, you).length);
  const discDiff = me === 'b' ? cnt.b - cnt.w : cnt.w - cnt.b;
  const discTerm = cnt.b + cnt.w > 54 ? 10 * discDiff : 0; // discs only matter late
  return pos + mob + discTerm;
}

// Fixed-perspective (for `me`) minimax with alpha-beta and pass handling. A position with no move for
// EITHER side is terminal and scored by the final disc margin.
function search(g, toMove, me, depth, alpha, beta) {
  const moves = legalFor(g, toMove);
  if (!moves.length) {
    if (!legalFor(g, other(toMove)).length) { // neither can move → terminal
      const cnt = counts(g);
      const d = me === 'b' ? cnt.b - cnt.w : cnt.w - cnt.b;
      return d > 0 ? 100000 + d : d < 0 ? -100000 + d : 0;
    }
    if (depth === 0) return evalGrid(g, me);
    return search(g, other(toMove), me, depth - 1, alpha, beta); // forced pass
  }
  if (depth === 0) return evalGrid(g, me);
  if (toMove === me) {
    let best = -Infinity;
    for (const { r, c } of cornerFirst(moves)) {
      best = Math.max(best, search(applied(g, r, c, toMove), other(toMove), me, depth - 1, alpha, beta));
      alpha = Math.max(alpha, best);
      if (alpha >= beta) break;
    }
    return best;
  }
  let best = Infinity;
  for (const { r, c } of cornerFirst(moves)) {
    best = Math.min(best, search(applied(g, r, c, toMove), other(toMove), me, depth - 1, alpha, beta));
    beta = Math.min(beta, best);
    if (alpha >= beta) break;
  }
  return best;
}

export function createOthello() {
  let grid = freshBoard();
  let turn = 'b';                 // Black to move first
  const stack = [];               // { r, c, color, flips, prevTurn } for undo

  const api = {
    reset() { grid = freshBoard(); turn = 'b'; stack.length = 0; },
    board() { return grid.map((row) => row.slice()); },
    turn() { return turn; },
    counts() { return counts(grid); },
    // Legal placements for the side to move (empty only if they must pass / the game is over).
    legalMoves() { return legalFor(grid, turn); },

    // Place a disc for the side to move; flip flanked discs; advance the turn, auto-passing an opponent
    // who has no reply (so `turn` only ever lands on a player who can actually move, unless it's over).
    move({ r, c } = {}) {
      if (!Number.isInteger(r) || !Number.isInteger(c) || !inb(r, c)) return { ok: false };
      const flips = flipsFor(grid, r, c, turn);
      if (!flips.length) return { ok: false };
      const color = turn;
      stack.push({ r, c, color, flips: flips.slice(), prevTurn: turn });
      grid[r][c] = color;
      for (const [fr, fc] of flips) grid[fr][fc] = color;
      let next = other(color);
      if (!legalFor(grid, next).length && legalFor(grid, color).length) next = color; // opponent passes
      turn = next;
      return { ok: true, flips: flips.slice(), turn };
    },

    // Over when neither colour has a legal move; winner is the majority (null = tie).
    status() {
      const cnt = counts(grid);
      if (legalFor(grid, 'b').length === 0 && legalFor(grid, 'w').length === 0) {
        const winner = cnt.b === cnt.w ? null : cnt.b > cnt.w ? 'b' : 'w';
        const hi = Math.max(cnt.b, cnt.w), lo = Math.min(cnt.b, cnt.w);
        return { over: true, winner, result: winner ? 'win' : 'draw', counts: cnt,
          reason: winner ? `${winner === 'b' ? 'Black' : 'White'} wins ${hi}–${lo}` : `Tied ${cnt.b}–${cnt.w}` };
      }
      return { over: false, winner: null, result: null, reason: '', counts: cnt };
    },

    undo() {
      const last = stack.pop();
      if (!last) return false;
      grid[last.r][last.c] = null;
      for (const [fr, fc] of last.flips) grid[fr][fc] = other(last.color);
      turn = last.prevTurn;
      return true;
    },
    history() { return stack.map((s) => ({ r: s.r, c: s.c })); },

    // Choose a move for the side to move. easy = shallow, hard = deep; ties broken randomly for variety.
    // (Never used in online play — moves are relayed, not AI-derived — so Math.random here is harmless.)
    aiMove(level = 'medium') {
      const moves = legalFor(grid, turn);
      if (!moves.length) return null;
      const me = turn;
      const depth = level === 'easy' ? 1 : level === 'hard' ? 5 : 3;
      let bestScore = -Infinity;
      const scored = [];
      for (const m of cornerFirst(moves)) {
        const s = search(applied(grid, m.r, m.c, me), other(me), me, depth - 1, -Infinity, Infinity);
        scored.push({ m, s });
        if (s > bestScore) bestScore = s;
      }
      const best = scored.filter((x) => x.s === bestScore).map((x) => x.m);
      return best[Math.floor(Math.random() * best.length)];
    },

    // A compact snapshot for ?state= share links: 64 cells ('.'/'b'/'w', row-major) + the side to move.
    serialize() {
      let s = '';
      for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) s += grid[r][c] || '.';
      return s + turn;
    },
    deserialize(token) {
      if (typeof token !== 'string' || token.length !== SIZE * SIZE + 1) return false;
      const t = token[SIZE * SIZE];
      if (t !== 'b' && t !== 'w') return false;
      const g = Array.from({ length: SIZE }, () => new Array(SIZE).fill(null));
      for (let i = 0; i < SIZE * SIZE; i++) {
        const ch = token[i];
        if (ch === 'b' || ch === 'w') g[(i / SIZE) | 0][i % SIZE] = ch;
        else if (ch !== '.') return false;
      }
      grid = g; turn = t; stack.length = 0;
      return true;
    },
  };
  return api;
}

export default { createOthello };
