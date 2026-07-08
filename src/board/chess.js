// board/chess.js — a self-contained, dependency-free chess ENGINE + AI. Pure logic, no DOM: it runs
// identically in the browser (imported by web/games/chess-view.js) and in Node (imported by the tests).
// This module is the "rules lawyer" for the game — it owns the board, generates ONLY fully-legal moves,
// detects check / mate / stalemate / draws, and can pick a decent move for the side to play.
//
// WHY 0x88: the board is a 128-entry Int8Array laid out as rank*16 + file. The top bit of each nibble
// is a cheap off-board sentinel — a square index `sq` is on the real 8x8 board iff `(sq & 0x88) === 0`.
// That single AND replaces four range comparisons in the hot move-generation loops, and slider rays can
// walk straight off the edge and be rejected in one test. Pieces are packed into a byte (colour bit +
// type nibble) so make/unmake during the AI search is just a couple of integer stores — no object
// churn, which is what keeps a depth-4 search under the ~1s budget.
//
// PUBLIC COORDINATES: everywhere the outside world touches this engine it uses {file, rank} with
//   file 0..7  = a..h   and   rank 0..7 = ranks 1..8   (so {file:4, rank:0} is e1, White's king start).
// board() returns rows[rank][file] with the SAME convention: rows[0] is rank 1 (White's home rank),
// rows[7] is rank 8. The view flips vertically at draw time so White sits at the bottom of the screen.

// ---- piece encoding ----------------------------------------------------------------------------------
// A square byte is 0 (empty) or (colourBit | typeNibble). Keeping colour as a single bit each lets us
// test/flip sides with a mask instead of a string compare in the search.
const EMPTY = 0;
const PAWN = 1, KNIGHT = 2, BISHOP = 3, ROOK = 4, QUEEN = 5, KING = 6;
const WHITE = 8, BLACK = 16;          // colour bits (kept clear of the type nibble 1..6)
const COLOR_MASK = WHITE | BLACK;     // 24
const typeOf = (p) => p & 7;
const colorOf = (p) => p & COLOR_MASK;
const isWhite = (p) => (p & WHITE) !== 0;

// Map the compact byte back to the public {type,color} object shape the view/tests expect.
const TYPE_CHAR = { [PAWN]: 'p', [KNIGHT]: 'n', [BISHOP]: 'b', [ROOK]: 'r', [QUEEN]: 'q', [KING]: 'k' };
const CHAR_TYPE = { p: PAWN, n: KNIGHT, b: BISHOP, r: ROOK, q: QUEEN, k: KING };

// ---- 0x88 geometry -----------------------------------------------------------------------------------
const sq88 = (file, rank) => (rank << 4) | file;     // {file,rank} -> 0x88 index
const fileOf = (sq) => sq & 7;
const rankOf = (sq) => sq >> 4;
const onBoard = (sq) => (sq & 0x88) === 0;
const to64 = (sq) => rankOf(sq) * 8 + fileOf(sq);    // 0x88 -> 0..63 (a1=0 .. h8=63), for tables/hashing

// Ray/step deltas in 0x88 space.
const KNIGHT_D = [33, 31, -31, -33, 18, 14, -14, -18];
const KING_D   = [16, -16, 1, -1, 17, 15, -17, -15];
const BISHOP_D = [17, 15, -17, -15];
const ROOK_D   = [16, -16, 1, -1];

// Castling rights as a bitmask so make/unmake is one integer op. Squares: e1=4 a1=0 h1=7, e8=116 a8=112 h8=119.
const CR_WK = 1, CR_WQ = 2, CR_BK = 4, CR_BQ = 8;
// A move touching one of these squares (as origin OR capture target) invalidates the matching right.
const CR_LOSS = new Int8Array(128);
CR_LOSS[sq88(4, 0)]  = CR_WK | CR_WQ;  // e1 (king moved)
CR_LOSS[sq88(0, 0)]  = CR_WQ;          // a1 rook
CR_LOSS[sq88(7, 0)]  = CR_WK;          // h1 rook
CR_LOSS[sq88(4, 7)]  = CR_BK | CR_BQ;  // e8
CR_LOSS[sq88(0, 7)]  = CR_BQ;          // a8 rook
CR_LOSS[sq88(7, 7)]  = CR_BK;          // h8 rook

// Standard starting layout, described file-by-file for rank 1 (mirrored for rank 8).
const BACK_RANK = [ROOK, KNIGHT, BISHOP, QUEEN, KING, BISHOP, KNIGHT, ROOK];

// ---- material + piece-square tables (centipawns) -----------------------------------------------------
// Values and tables are the well-worn "simplified evaluation" set. Tables below are written rank-8-first
// (index 0 = a8) reading naturally like a board from White's side; pstValue() flips them per colour.
const VALUE = { [PAWN]: 100, [KNIGHT]: 320, [BISHOP]: 330, [ROOK]: 500, [QUEEN]: 900, [KING]: 20000 };

const PST = {
  [PAWN]: [
      0,  0,  0,  0,  0,  0,  0,  0,
     50, 50, 50, 50, 50, 50, 50, 50,
     10, 10, 20, 30, 30, 20, 10, 10,
      5,  5, 10, 25, 25, 10,  5,  5,
      0,  0,  0, 20, 20,  0,  0,  0,
      5, -5,-10,  0,  0,-10, -5,  5,
      5, 10, 10,-20,-20, 10, 10,  5,
      0,  0,  0,  0,  0,  0,  0,  0,
  ],
  [KNIGHT]: [
    -50,-40,-30,-30,-30,-30,-40,-50,
    -40,-20,  0,  0,  0,  0,-20,-40,
    -30,  0, 10, 15, 15, 10,  0,-30,
    -30,  5, 15, 20, 20, 15,  5,-30,
    -30,  0, 15, 20, 20, 15,  0,-30,
    -30,  5, 10, 15, 15, 10,  5,-30,
    -40,-20,  0,  5,  5,  0,-20,-40,
    -50,-40,-30,-30,-30,-30,-40,-50,
  ],
  [BISHOP]: [
    -20,-10,-10,-10,-10,-10,-10,-20,
    -10,  0,  0,  0,  0,  0,  0,-10,
    -10,  0,  5, 10, 10,  5,  0,-10,
    -10,  5,  5, 10, 10,  5,  5,-10,
    -10,  0, 10, 10, 10, 10,  0,-10,
    -10, 10, 10, 10, 10, 10, 10,-10,
    -10,  5,  0,  0,  0,  0,  5,-10,
    -20,-10,-10,-10,-10,-10,-10,-20,
  ],
  [ROOK]: [
      0,  0,  0,  0,  0,  0,  0,  0,
      5, 10, 10, 10, 10, 10, 10,  5,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
      0,  0,  0,  5,  5,  0,  0,  0,
  ],
  [QUEEN]: [
    -20,-10,-10, -5, -5,-10,-10,-20,
    -10,  0,  0,  0,  0,  0,  0,-10,
    -10,  0,  5,  5,  5,  5,  0,-10,
     -5,  0,  5,  5,  5,  5,  0, -5,
      0,  0,  5,  5,  5,  5,  0, -5,
    -10,  5,  5,  5,  5,  5,  0,-10,
    -10,  0,  5,  0,  0,  0,  0,-10,
    -20,-10,-10, -5, -5,-10,-10,-20,
  ],
  [KING]: [
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -20,-30,-30,-40,-40,-30,-30,-20,
    -10,-20,-20,-20,-20,-20,-20,-10,
     20, 20,  0,  0,  0,  0, 20, 20,
     20, 30, 10,  0,  0, 10, 30, 20,
  ],
};
// White reads the table flipped (its rank 1 is the table's bottom row); Black reads it as written.
function pstValue(type, sq, white) {
  const f = fileOf(sq), r = rankOf(sq);
  const idx = white ? (7 - r) * 8 + f : r * 8 + f;
  return PST[type][idx];
}

const MATE = 1_000_000;       // score for being checkmated (offset by ply so faster mates score higher)
const MOBILITY_WEIGHT = 2;    // centipawns per pseudo-legal move — a light nudge toward active pieces

// =====================================================================================================
// createChess() — the whole engine behind one controller object. State lives in the closure so several
// independent games can coexist (the view keeps one; the tests spin up many).
// =====================================================================================================
export function createChess() {
  // --- mutable game state -----------------------------------------------------------------------------
  const board = new Int8Array(128); // 0x88 board; off-board slots stay 0 and are never read as pieces
  let turn = WHITE;                 // side to move
  let castling = 0;                 // CR_* bitmask
  let ep = -1;                      // en-passant TARGET square (the empty square a pawn skipped), or -1
  let half = 0;                     // half-move clock for the 50-move rule (plies since pawn move/capture)
  let full = 1;                     // full-move number (informational)
  const kingSq = { [WHITE]: -1, [BLACK]: -1 }; // cached king squares for fast in-check tests

  // Undo stack: every _make pushes a frame so _unmake is an exact reversal. Shared by the AI search AND
  // the public move()/undo(), so at rest the stack length equals the number of moves played this game.
  const stack = [];
  // Repetition bookkeeping lives only on the PUBLIC path (search never revisits the same root position),
  // so the AII search's make/unmake stays free of any string hashing.
  let repMap = new Map();
  const repStack = [];

  const other = (c) => c ^ COLOR_MASK; // WHITE<->BLACK

  // --- setup ------------------------------------------------------------------------------------------
  function reset() {
    board.fill(0);
    for (let f = 0; f < 8; f++) {
      board[sq88(f, 0)] = WHITE | BACK_RANK[f];
      board[sq88(f, 1)] = WHITE | PAWN;
      board[sq88(f, 6)] = BLACK | PAWN;
      board[sq88(f, 7)] = BLACK | BACK_RANK[f];
    }
    turn = WHITE;
    castling = CR_WK | CR_WQ | CR_BK | CR_BQ;
    ep = -1; half = 0; full = 1;
    kingSq[WHITE] = sq88(4, 0);
    kingSq[BLACK] = sq88(4, 7);
    stack.length = 0;
    repStack.length = 0;
    repMap = new Map();
    repMap.set(positionKey(), 1); // the start position counts as its first occurrence
  }

  // --- attack + check queries -------------------------------------------------------------------------
  // Is `sq` attacked by any piece of colour `by`? Used for check detection and castling legality.
  function attacked(sq, by) {
    const enemyPawn = by | PAWN, enemyKnight = by | KNIGHT, enemyKing = by | KING;
    const enemyBishop = by | BISHOP, enemyRook = by | ROOK, enemyQueen = by | QUEEN;
    // Pawns: a `by`-coloured pawn attacks "forward" for its colour, so it sits on the opposite diagonal.
    if (by === WHITE) {
      if (onBoard(sq - 17) && board[sq - 17] === enemyPawn) return true;
      if (onBoard(sq - 15) && board[sq - 15] === enemyPawn) return true;
    } else {
      if (onBoard(sq + 17) && board[sq + 17] === enemyPawn) return true;
      if (onBoard(sq + 15) && board[sq + 15] === enemyPawn) return true;
    }
    // Knights + kings: fixed offsets.
    for (let i = 0; i < 8; i++) {
      const k = sq + KNIGHT_D[i];
      if (onBoard(k) && board[k] === enemyKnight) return true;
      const g = sq + KING_D[i];
      if (onBoard(g) && board[g] === enemyKing) return true;
    }
    // Sliders: walk each ray until it hits something; the first piece decides.
    for (let i = 0; i < 4; i++) {
      let t = sq + BISHOP_D[i];
      while (onBoard(t)) {
        const p = board[t];
        if (p) { if (p === enemyBishop || p === enemyQueen) return true; break; }
        t += BISHOP_D[i];
      }
      t = sq + ROOK_D[i];
      while (onBoard(t)) {
        const p = board[t];
        if (p) { if (p === enemyRook || p === enemyQueen) return true; break; }
        t += ROOK_D[i];
      }
    }
    return false;
  }

  const inCheck = (color) => attacked(kingSq[color], other(color));

  // --- move generation --------------------------------------------------------------------------------
  // Internal move shape: { from, to, flags, piece, promo, captured, capSq }. `flags` is a small string of
  // chars (chess.js-style): n normal, c capture, b double-push, e en-passant, p promotion, k/q castle.
  function mk(from, to, flags, piece, promo = 0, captured = 0, capSq = -1) {
    return { from, to, flags, piece, promo, captured, capSq };
  }

  // Pseudo-legal moves for `color` (may leave own king in check — filtered later). `capturesOnly` powers
  // the quiescence search and skips quiet moves + castling.
  function genPseudo(color, capturesOnly = false) {
    const moves = [];
    const forward = color === WHITE ? 16 : -16;
    const startRank = color === WHITE ? 1 : 6;
    const lastRank = color === WHITE ? 7 : 0;
    const capDeltas = color === WHITE ? [17, 15] : [-17, -15];

    for (let sq = 0; sq < 128; sq++) {
      if (sq & 0x88) { sq += 7; continue; }     // skip the off-board half of each rank in one jump
      const p = board[sq];
      if (!p || colorOf(p) !== color) continue;
      const t = typeOf(p);

      if (t === PAWN) {
        // Captures (incl. en-passant + promotion-on-capture).
        for (const d of capDeltas) {
          const to = sq + d;
          if (!onBoard(to)) continue;
          const tp = board[to];
          if (tp && colorOf(tp) !== color) {
            pushPawn(moves, sq, to, p, 'c', tp, to, lastRank);
          } else if (to === ep && ep !== -1) {
            const capSq = to - forward; // the pawn being captured sits beside us, not on `to`
            moves.push(mk(sq, to, 'e', p, 0, board[capSq], capSq));
          }
        }
        if (capturesOnly) continue;
        // Single + double forward pushes.
        const one = sq + forward;
        if (onBoard(one) && !board[one]) {
          pushPawn(moves, sq, one, p, 'n', 0, -1, lastRank);
          const two = one + forward;
          if (rankOf(sq) === startRank && !board[two]) {
            moves.push(mk(sq, two, 'b', p)); // double-step; sets an ep target when made
          }
        }
        continue;
      }

      if (t === KNIGHT || t === KING) {
        const deltas = t === KNIGHT ? KNIGHT_D : KING_D;
        for (let i = 0; i < 8; i++) {
          const to = sq + deltas[i];
          if (!onBoard(to)) continue;
          const tp = board[to];
          if (!tp) { if (!capturesOnly) moves.push(mk(sq, to, 'n', p)); }
          else if (colorOf(tp) !== color) moves.push(mk(sq, to, 'c', p, 0, tp, to));
        }
        continue;
      }

      // Sliding pieces.
      const deltas = t === BISHOP ? BISHOP_D : t === ROOK ? ROOK_D : KING_D; // queen uses all 8 (KING_D)
      const nDirs = deltas.length;
      for (let i = 0; i < nDirs; i++) {
        let to = sq + deltas[i];
        while (onBoard(to)) {
          const tp = board[to];
          if (!tp) { if (!capturesOnly) moves.push(mk(sq, to, 'n', p)); }
          else { if (colorOf(tp) !== color) moves.push(mk(sq, to, 'c', p, 0, tp, to)); break; }
          to += deltas[i];
        }
      }
    }

    // Castling — only as a quiet move, and only when every legality condition holds up front (rights,
    // empty transit squares, king not currently in check and not walking through/into an attacked square).
    if (!capturesOnly) addCastles(moves, color);
    return moves;
  }

  // Expand a pawn move into the four promotion choices on the last rank, else a single plain move.
  function pushPawn(moves, from, to, piece, baseFlag, captured, capSq, lastRank) {
    if (rankOf(to) === lastRank) {
      for (const promo of [QUEEN, ROOK, BISHOP, KNIGHT]) {
        moves.push(mk(from, to, baseFlag + 'p', piece, promo, captured, capSq));
      }
    } else {
      moves.push(mk(from, to, baseFlag, piece, 0, captured, capSq));
    }
  }

  function addCastles(moves, color) {
    const enemy = other(color);
    if (color === WHITE) {
      const e1 = sq88(4, 0);
      if (kingSq[WHITE] !== e1 || attacked(e1, enemy)) return; // must have the king home and unchecked
      if ((castling & CR_WK) && !board[sq88(5, 0)] && !board[sq88(6, 0)] &&
          !attacked(sq88(5, 0), enemy) && !attacked(sq88(6, 0), enemy)) {
        moves.push(mk(e1, sq88(6, 0), 'k', WHITE | KING));
      }
      if ((castling & CR_WQ) && !board[sq88(3, 0)] && !board[sq88(2, 0)] && !board[sq88(1, 0)] &&
          !attacked(sq88(3, 0), enemy) && !attacked(sq88(2, 0), enemy)) {
        moves.push(mk(e1, sq88(2, 0), 'q', WHITE | KING));
      }
    } else {
      const e8 = sq88(4, 7);
      if (kingSq[BLACK] !== e8 || attacked(e8, enemy)) return;
      if ((castling & CR_BK) && !board[sq88(5, 7)] && !board[sq88(6, 7)] &&
          !attacked(sq88(5, 7), enemy) && !attacked(sq88(6, 7), enemy)) {
        moves.push(mk(e8, sq88(6, 7), 'k', BLACK | KING));
      }
      if ((castling & CR_BQ) && !board[sq88(3, 7)] && !board[sq88(2, 7)] && !board[sq88(1, 7)] &&
          !attacked(sq88(3, 7), enemy) && !attacked(sq88(2, 7), enemy)) {
        moves.push(mk(e8, sq88(2, 7), 'q', BLACK | KING));
      }
    }
  }

  // Fully-legal moves: generate pseudo-legal, then keep only those that don't leave our own king attacked.
  function genLegal(color) {
    const pseudo = genPseudo(color);
    const legal = [];
    for (const m of pseudo) {
      _make(m);
      if (!attacked(kingSq[color], other(color))) legal.push(m);
      _unmake(m);
    }
    return legal;
  }

  // --- make / unmake (the hot path) -------------------------------------------------------------------
  function _make(m) {
    const color = colorOf(m.piece);
    const frame = { m, castling, ep, half, full, kw: kingSq[WHITE], kb: kingSq[BLACK] };
    stack.push(frame);

    // Lift any captured piece (en-passant captures a square other than `to`).
    if (m.capSq >= 0) board[m.capSq] = EMPTY;

    // Place the moving piece (promoting if needed) and vacate the origin.
    board[m.to] = m.promo ? (color | m.promo) : m.piece;
    board[m.from] = EMPTY;

    // Move the rook when castling.
    if (m.flags.includes('k')) {
      const r = color === WHITE ? 0 : 7;
      board[sq88(5, r)] = board[sq88(7, r)]; board[sq88(7, r)] = EMPTY;
    } else if (m.flags.includes('q')) {
      const r = color === WHITE ? 0 : 7;
      board[sq88(3, r)] = board[sq88(0, r)]; board[sq88(0, r)] = EMPTY;
    }

    if (typeOf(m.piece) === KING) kingSq[color] = m.to;

    // Update castling rights: any touch of a king/rook home square (moving from it OR capturing on it).
    castling &= ~(CR_LOSS[m.from] | CR_LOSS[m.to]);

    // Set the en-passant target only after a double pawn push; otherwise clear it.
    ep = m.flags === 'b' ? (m.from + (color === WHITE ? 16 : -16)) : -1;

    // 50-move clock: resets on any pawn move or capture.
    half = (typeOf(m.piece) === PAWN || m.captured || m.capSq >= 0) ? 0 : half + 1;
    if (color === BLACK) full++;
    turn = other(color);
  }

  function _unmake(m) {
    const frame = stack.pop();
    const color = colorOf(m.piece);
    turn = color;
    castling = frame.castling; ep = frame.ep; half = frame.half; full = frame.full;
    kingSq[WHITE] = frame.kw; kingSq[BLACK] = frame.kb;

    // Undo the rook shuffle from castling.
    if (m.flags.includes('k')) {
      const r = color === WHITE ? 0 : 7;
      board[sq88(7, r)] = board[sq88(5, r)]; board[sq88(5, r)] = EMPTY;
    } else if (m.flags.includes('q')) {
      const r = color === WHITE ? 0 : 7;
      board[sq88(0, r)] = board[sq88(3, r)]; board[sq88(3, r)] = EMPTY;
    }

    board[m.from] = m.piece;   // restore the pre-promotion piece
    board[m.to] = EMPTY;
    if (m.capSq >= 0) board[m.capSq] = m.captured; // put a captured piece back (works for en-passant too)
  }

  // --- evaluation -------------------------------------------------------------------------------------
  // Static score from the side-to-move's point of view (positive = good for the mover). Material +
  // piece-square placement + a light mobility term.
  function evaluate() {
    let score = 0; // White minus Black
    for (let sq = 0; sq < 128; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      const p = board[sq];
      if (!p) continue;
      const t = typeOf(p), white = isWhite(p);
      const v = VALUE[t] + pstValue(t, sq, white);
      score += white ? v : -v;
    }
    // Mobility: cheap pseudo-legal move counts for both sides (a decent proxy for activity).
    score += MOBILITY_WEIGHT * (genPseudo(WHITE).length - genPseudo(BLACK).length);
    return turn === WHITE ? score : -score;
  }

  // --- search (negamax + alpha-beta, captures-first ordering, quiescence at the leaves) ---------------
  function orderMoves(moves) {
    // MVV-LVA-ish: try the most promising moves first so alpha-beta prunes hard. Promotions and captures
    // of valuable pieces float to the top; ties keep generation order (deterministic).
    for (const m of moves) {
      let s = 0;
      if (m.captured) s += 10 * VALUE[typeOf(m.captured)] - VALUE[typeOf(m.piece)];
      if (m.promo) s += VALUE[m.promo];
      m._score = s;
    }
    moves.sort((a, b) => b._score - a._score);
    return moves;
  }

  function quiesce(alpha, beta, ply) {
    // Stand-pat: assume we can at least "do nothing" — then only search captures to reach a quiet position
    // and dodge the horizon effect (e.g. not stopping the search mid-exchange).
    let best = evaluate();
    if (best >= beta) return best;
    if (best > alpha) alpha = best;
    if (ply > 6) return best; // safety cap; capture chains are naturally short but this bounds the worst case

    const color = turn;
    const caps = orderMoves(genPseudo(color, true));
    for (const m of caps) {
      _make(m);
      const legal = !attacked(kingSq[color], other(color));
      let score = 0;
      if (legal) score = -quiesce(-beta, -alpha, ply + 1);
      _unmake(m);
      if (!legal) continue;
      if (score > best) best = score;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    return best;
  }

  function negamax(depth, alpha, beta, ply, useQuiescence) {
    if (depth <= 0) return useQuiescence ? quiesce(alpha, beta, 0) : evaluate();

    const color = turn;
    const moves = orderMoves(genPseudo(color));
    let best = -Infinity, anyLegal = false;
    for (const m of moves) {
      _make(m);
      if (attacked(kingSq[color], other(color))) { _unmake(m); continue; } // illegal, skip
      anyLegal = true;
      const score = -negamax(depth - 1, -beta, -alpha, ply + 1, useQuiescence);
      _unmake(m);
      if (score > best) best = score;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    if (!anyLegal) return inCheck(color) ? -MATE + ply : 0; // checkmate (prefer quick mates) or stalemate
    return best;
  }

  // Pick a move for the side to move WITHOUT applying it. Levels tune depth + determinism:
  //   easy   — depth 1 with a random pick among near-best moves (beatable, varied; uses Math.random).
  //   medium — depth 3, deterministic.
  //   hard   — depth 4 + quiescence, deterministic. Move ordering keeps this well under ~1s.
  function aiMove(level = 'medium') {
    const color = turn;
    const legal = genLegal(color);
    if (legal.length === 0) return null;

    const depth = level === 'easy' ? 1 : level === 'medium' ? 3 : 4;
    const useQuiescence = level === 'hard';
    orderMoves(legal);

    let bestScore = -Infinity;
    const scored = [];
    let alpha = -Infinity;
    for (const m of legal) {
      _make(m);
      const score = -negamax(depth - 1, -Infinity, -alpha, 1, useQuiescence);
      _unmake(m);
      scored.push({ m, score });
      if (score > bestScore) bestScore = score;
      // Root stays full-window (no alpha raise) for easy so the near-best pool is meaningful; medium/hard
      // can narrow to prune a little harder while still returning the true best.
      if (level !== 'easy' && score > alpha) alpha = score;
    }

    if (level === 'easy') {
      // Choose randomly among moves within a pawn of the best — keeps it lively and losable.
      const pool = scored.filter((s) => s.score >= bestScore - 60).map((s) => s.m);
      return pub(pool[Math.floor(Math.random() * pool.length)]);
    }
    // Deterministic: first move achieving the best score (generation order breaks ties stably).
    for (const s of scored) if (s.score === bestScore) return pub(s.m);
    return pub(scored[0].m);
  }

  // --- draw detection ---------------------------------------------------------------------------------
  function insufficientMaterial() {
    // Enough to force mate? Any pawn/rook/queen means yes. Otherwise it comes down to the minor count.
    let minors = 0;
    for (let sq = 0; sq < 128; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      const p = board[sq];
      if (!p) continue;
      const t = typeOf(p);
      if (t === PAWN || t === ROOK || t === QUEEN) return false;
      if (t === BISHOP || t === KNIGHT) minors++;
    }
    return minors <= 1; // K vs K, or K + single minor vs K — neither side can force mate
  }

  // Compact key of the current position for threefold repetition (pieces + side + rights + ep file).
  function positionKey() {
    let s = '';
    for (let sq = 0; sq < 128; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      s += board[sq] ? String.fromCharCode(64 + board[sq]) : '.';
    }
    return s + (turn === WHITE ? 'w' : 'b') + castling + (ep >= 0 ? fileOf(ep) : '-');
  }

  // --- FEN (Forsyth–Edwards Notation) -----------------------------------------------------------------
  // FEN is the standard, compact, human-readable codec for a chess position and doubles as our share
  // token (only the spaces need escaping, which the harness handles). Six fields: piece placement (rank 8
  // first), side to move, castling rights, en-passant target, halfmove clock, fullmove number.
  const FILE_CHARS = 'abcdefgh';

  function fen() {
    let placement = '';
    for (let r = 7; r >= 0; r--) {          // FEN lists rank 8 down to rank 1
      let run = 0, row = '';
      for (let f = 0; f < 8; f++) {
        const p = board[sq88(f, r)];
        if (!p) { run++; continue; }
        if (run) { row += run; run = 0; }   // collapse a stretch of empties into a digit
        const ch = TYPE_CHAR[typeOf(p)];
        row += isWhite(p) ? ch.toUpperCase() : ch;
      }
      if (run) row += run;
      placement += (r < 7 ? '/' : '') + row;
    }
    let cr = '';
    if (castling & CR_WK) cr += 'K';
    if (castling & CR_WQ) cr += 'Q';
    if (castling & CR_BK) cr += 'k';
    if (castling & CR_BQ) cr += 'q';
    const epStr = ep >= 0 ? FILE_CHARS[fileOf(ep)] + (rankOf(ep) + 1) : '-';
    return `${placement} ${turn === WHITE ? 'w' : 'b'} ${cr || '-'} ${epStr} ${half} ${full}`;
  }

  // Parse a FEN string and, only if it is well-formed, replace the whole game state with it. Returns true
  // on success / false on any malformed field (nothing is mutated on failure). History is reset — a FEN is
  // a standalone snapshot with no move list — so undo() has nothing to rewind past the loaded position.
  function loadFEN(str) {
    if (typeof str !== 'string') return false;
    const parts = str.trim().split(/\s+/);
    if (parts.length < 4) return false;          // need at least placement/side/castling/ep
    const [placement, side, cr, epStr] = parts;

    const rows = placement.split('/');
    if (rows.length !== 8) return false;

    // Build into scratch state first so a bad field can't corrupt the live board.
    const nb = new Int8Array(128);
    const kings = { [WHITE]: -1, [BLACK]: -1 };
    for (let i = 0; i < 8; i++) {
      const r = 7 - i;                            // rows[0] is rank 8
      let f = 0;
      for (const ch of rows[i]) {
        if (ch >= '1' && ch <= '8') { f += ch.charCodeAt(0) - 48; continue; }
        const t = CHAR_TYPE[ch.toLowerCase()];
        if (!t || f > 7) return false;
        const color = ch === ch.toLowerCase() ? BLACK : WHITE; // lowercase = black, uppercase = white
        const sq = sq88(f, r);
        nb[sq] = color | t;
        if (t === KING) { if (kings[color] >= 0) return false; kings[color] = sq; } // exactly one king each
        f++;
      }
      if (f !== 8) return false;                  // every rank must describe exactly 8 files
    }
    if (kings[WHITE] < 0 || kings[BLACK] < 0) return false;

    let nTurn;
    if (side === 'w') nTurn = WHITE; else if (side === 'b') nTurn = BLACK; else return false;

    let nCastle = 0;
    if (cr !== '-') {
      for (const ch of cr) {
        if (ch === 'K') nCastle |= CR_WK;
        else if (ch === 'Q') nCastle |= CR_WQ;
        else if (ch === 'k') nCastle |= CR_BK;
        else if (ch === 'q') nCastle |= CR_BQ;
        else return false;
      }
    }

    let nEp = -1;
    if (epStr !== '-') {
      if (epStr.length !== 2) return false;
      const ef = FILE_CHARS.indexOf(epStr[0]);
      const er = epStr.charCodeAt(1) - 49;        // '1' -> 0
      if (ef < 0 || er < 0 || er > 7) return false;
      nEp = sq88(ef, er);
    }

    const nHalf = parts.length > 4 ? parseInt(parts[4], 10) : 0;
    const nFull = parts.length > 5 ? parseInt(parts[5], 10) : 1;
    if (!Number.isFinite(nHalf) || nHalf < 0 || !Number.isFinite(nFull) || nFull < 1) return false;

    // Commit — everything validated.
    board.set(nb);
    turn = nTurn; castling = nCastle; ep = nEp; half = nHalf; full = nFull;
    kingSq[WHITE] = kings[WHITE]; kingSq[BLACK] = kings[BLACK];
    stack.length = 0; repStack.length = 0;
    repMap = new Map(); repMap.set(positionKey(), 1);
    return true;
  }

  // --- public status ----------------------------------------------------------------------------------
  function status() {
    const color = turn;
    const legal = genLegal(color);
    const checked = inCheck(color);
    if (legal.length === 0) {
      if (checked) {
        const winner = color === WHITE ? 'b' : 'w';
        return { over: true, result: 'checkmate', winner, inCheck: true,
                 reason: `Checkmate — ${winner === 'w' ? 'White' : 'Black'} wins` };
      }
      return { over: true, result: 'stalemate', winner: null, inCheck: false, reason: 'Stalemate — draw' };
    }
    if (insufficientMaterial())
      return { over: true, result: 'draw', winner: null, inCheck: checked, reason: 'Draw — insufficient material' };
    if (half >= 100)
      return { over: true, result: 'draw', winner: null, inCheck: checked, reason: 'Draw — 50-move rule' };
    if ((repMap.get(positionKey()) || 0) >= 3)
      return { over: true, result: 'draw', winner: null, inCheck: checked, reason: 'Draw — threefold repetition' };
    return { over: false, result: null, winner: null, inCheck: checked,
             reason: checked ? 'Check' : '' };
  }

  // --- public <-> internal conversion -----------------------------------------------------------------
  const coord = (sq) => ({ file: fileOf(sq), rank: rankOf(sq) });
  const pub = (m) => ({
    from: coord(m.from), to: coord(m.to), flags: m.flags,
    promotion: m.promo ? TYPE_CHAR[m.promo] : undefined,
  });

  // --- public API -------------------------------------------------------------------------------------
  // board()[rank][file] — rank 0 = rank 1 (White's home), file 0 = a. Each cell is {type,color} or null.
  function boardGrid() {
    const rows = [];
    for (let r = 0; r < 8; r++) {
      const row = [];
      for (let f = 0; f < 8; f++) {
        const p = board[sq88(f, r)];
        row.push(p ? { type: TYPE_CHAR[typeOf(p)], color: isWhite(p) ? 'w' : 'b' } : null);
      }
      rows.push(row);
    }
    return rows;
  }

  function legalMovesFrom({ file, rank }) {
    const from = sq88(file, rank);
    return genLegal(turn).filter((m) => m.from === from).map(pub);
  }

  function allLegalMoves() { return genLegal(turn).map(pub); }

  // Apply a public move { from:{file,rank}, to:{file,rank}, promotion? }. Rejects anything illegal.
  function move(m) {
    const from = sq88(m.from.file, m.from.rank);
    const to = sq88(m.to.file, m.to.rank);
    const promo = m.promotion ? CHAR_TYPE[m.promotion] : QUEEN; // default queen when a promotion is needed
    const legal = genLegal(turn);
    const chosen = legal.find((x) =>
      x.from === from && x.to === to && (!x.promo || x.promo === promo));
    if (!chosen) return { ok: false };

    const mover = colorOf(chosen.piece);
    _make(chosen);
    // Repetition/history bookkeeping (public path only).
    const key = positionKey();
    repMap.set(key, (repMap.get(key) || 0) + 1);
    repStack.push(key);

    const st = status();
    return {
      ok: true,
      captured: chosen.captured ? { type: TYPE_CHAR[typeOf(chosen.captured)], color: isWhite(chosen.captured) ? 'w' : 'b' } : null,
      check: inCheck(other(mover)),
      flags: chosen.flags,
      promotion: chosen.promo ? TYPE_CHAR[chosen.promo] : undefined,
      over: st.over, result: st.result, winner: st.winner,
    };
  }

  function undo() {
    if (stack.length === 0) return null;
    const frame = stack[stack.length - 1];
    const m = frame.m;
    // Reverse the public bookkeeping before unwinding the position.
    const key = repStack.pop();
    if (key !== undefined) {
      const n = (repMap.get(key) || 0) - 1;
      if (n > 0) repMap.set(key, n); else repMap.delete(key);
    }
    _unmake(m);
    return pub(m);
  }

  function history() { return stack.map((frame) => pub(frame.m)); }

  reset();
  return {
    reset,
    board: boardGrid,
    turn: () => (turn === WHITE ? 'w' : 'b'),
    inCheck: () => inCheck(turn),
    legalMovesFrom,
    allLegalMoves,
    move,
    status,
    aiMove,
    undo,
    history,
    fen,
    loadFEN,
  };
}

export default { createChess };
