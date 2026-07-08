// backgammon.js — a pure, DOM-free backgammon ENGINE + heuristic AI for the board-games compendium.
// No frameworks, no dependencies; runs identically in the browser and under node:test. The view
// (web/games/backgammon-view.js) owns the canvas and input; this file owns all the rules.
//
// ---- COORDINATE SCHEME (read this before touching move logic) --------------------------------
// Points are indexed 0..23 from WHITE's perspective. The signed board `pts[24]` holds one int per
// point: POSITIVE = that many WHITE checkers, NEGATIVE = that many BLACK checkers, 0 = empty.
//
//   index:  0   1   2   3   4   5  | 6 ... 11 | 12 ... 17 | 18  19  20  21  22  23
//           \_____ white home _____/                        \___ black home _______/
//
//   • WHITE moves toward index 0 (decreasing) and bears off "past" index 0.
//   • BLACK moves toward index 23 (increasing) and bears off "past" index 23.
//   • WHITE's home board is indices 0..5; BLACK's home board is indices 18..23.
//   • A checker on point P in a player's OWN 1..24 numbering is worth P pips. For white that is
//     (index+1); for black that is (24-index). The bar is worth 25 pips. Sum = the pip count.
//
// Standard opening position (matches "2 on the 24-pt, 5 on 13, 3 on 8, 5 on 6" for each side):
//   white: 2@23, 5@12, 3@7, 5@5    black: 2@0, 5@11, 3@16, 5@18   → 167 pips each.
//
// A "move" spends ONE die to advance ONE checker that many pips in the player's direction. Doubles
// grant FOUR moves of that value. The engine enumerates full legal move-SEQUENCES for the rolled
// dice so it can enforce the awkward "use as many dice as you can, and the larger die if you can
// only use one" rules correctly — you cannot get that right by judging the two dice independently.
//
// Gammon/backgammon scoring and the doubling cube are OUT OF SCOPE for v1: bearing all 15 off is a
// plain single-point win.

const WHITE = 'w';
const BLACK = 'b';
const other = (c) => (c === WHITE ? BLACK : WHITE);

// Number of the 36 two-dice rolls that hit a lone blot at a given pip distance, ignoring blocked
// intermediate points (direct + common indirect shots). Used only to weight blot exposure in the AI.
const SHOTS = [0, 11, 12, 14, 15, 15, 17, 6, 6, 5, 4, 2, 3, 0, 1, 1, 1, 0, 1, 0, 1, 0, 0, 0, 1];

// ---- share codec ----------------------------------------------------------------------------
// A whole resumable position (board + whose turn) packs into a short, fixed-length URL-safe token.
// Layout, one base64url character per field:
//   [0]       version marker '1'
//   [1..24]   the 24 points, each as (signedCount + 15) → 0..30   (sign = colour, magnitude 0..15)
//   [25][26]  bar counts:  white, black
//   [27][28]  off counts:  white, black
//   [29]      turn: 'w' | 'b'
// We deliberately serialize ONLY the board + turn, never the dice or a partial move: a shared link
// hands the recipient a clean "your roll" state. If the sharer had already rolled or half-played, the
// board is captured exactly as it stands (partial moves included) with the turn left on the current
// player, who simply re-rolls — see serialize().
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function serializeBoard(b, turn) {
  let s = '1';
  for (let i = 0; i < 24; i++) s += B64[b.pts[i] + 15]; // -15..15 → 0..30
  s += B64[b.barW] + B64[b.barB];
  s += B64[b.offW] + B64[b.offB];
  s += turn === WHITE ? 'w' : 'b';
  return s;
}

// Parse + VALIDATE a token. Returns { pts, barW, barB, offW, offB, turn } or null for anything that
// isn't a well-formed, checker-conserving position (each colour must total exactly 15).
function parseToken(token) {
  if (typeof token !== 'string' || token.length !== 30 || token[0] !== '1') return null;
  const pts = new Int8Array(24);
  for (let i = 0; i < 24; i++) {
    const v = B64.indexOf(token[1 + i]);
    if (v < 0 || v > 30) return null; // outside the -15..15 signed-count range
    pts[i] = v - 15;
  }
  const barW = B64.indexOf(token[25]), barB = B64.indexOf(token[26]);
  const offW = B64.indexOf(token[27]), offB = B64.indexOf(token[28]);
  const turnCh = token[29];
  if ([barW, barB, offW, offB].some((x) => x < 0 || x > 15)) return null;
  if (turnCh !== 'w' && turnCh !== 'b') return null;
  let w = 0, bl = 0;
  for (let i = 0; i < 24; i++) { const v = pts[i]; if (v > 0) w += v; else if (v < 0) bl += -v; }
  w += barW + offW; bl += barB + offB;
  if (w !== 15 || bl !== 15) return null; // reject impossible checker totals
  return { pts, barW, barB, offW, offB, turn: turnCh === 'w' ? WHITE : BLACK };
}

// A compact, cloneable board snapshot. Everything the rules touch lives here (no turn/dice state).
function freshBoard() {
  const pts = new Int8Array(24);
  pts[0] = -2; pts[5] = 5; pts[7] = 3; pts[11] = -5;
  pts[12] = 5; pts[16] = -3; pts[18] = -5; pts[23] = 2;
  return { pts, barW: 0, barB: 0, offW: 0, offB: 0 };
}
function cloneBoard(b) {
  return { pts: b.pts.slice(), barW: b.barW, barB: b.barB, offW: b.offW, offB: b.offB };
}
function boardKey(b) {
  // Stable string key for de-duplicating identical resulting positions during AI search.
  return b.pts.join(',') + '|' + b.barW + '|' + b.barB + '|' + b.offW + '|' + b.offB;
}

const bar = (b, c) => (c === WHITE ? b.barW : b.barB);
const off = (b, c) => (c === WHITE ? b.offW : b.offB);
const inHome = (c, i) => (c === WHITE ? i <= 5 : i >= 18);

// Pip count for a colour on a given board (lower is better; 0 means fully borne off).
function pipCount(b, c) {
  let p = 0;
  for (let i = 0; i < 24; i++) {
    const v = b.pts[i];
    if (c === WHITE && v > 0) p += (i + 1) * v;
    else if (c === BLACK && v < 0) p += (24 - i) * (-v);
  }
  return p + bar(b, c) * 25;
}

// Are all 15 of colour c in their home board (a precondition for bearing off)?
function allHome(b, c) {
  if (bar(b, c) > 0) return false;
  if (c === WHITE) { for (let i = 6; i < 24; i++) if (b.pts[i] > 0) return false; }
  else { for (let i = 0; i < 18; i++) if (b.pts[i] < 0) return false; }
  return true;
}

// Can colour c land on point `dest`? (empty, own, or a lone enemy blot — never 2+ enemy checkers.)
function canLand(b, c, dest) {
  const v = b.pts[dest];
  return c === WHITE ? v >= -1 : v <= 1;
}
function isBlot(b, c, dest) {
  const v = b.pts[dest];
  return c === WHITE ? v === -1 : v === 1;
}

// The pip distance a checker at index i still needs to bear off.
const bearDist = (c, i) => (c === WHITE ? i + 1 : 24 - i);

// May colour c bear a checker off the point at index i using die `die`? Assumes allHome already.
function canBearOff(b, c, i, die) {
  const dist = bearDist(c, i);
  if (die === dist) return true;         // exact roll
  if (die < dist) return false;          // not a bear-off (stays on the board)
  // Over-roll: legal only if no checker sits on a HIGHER point (farther from the edge).
  if (c === WHITE) { for (let k = i + 1; k <= 5; k++) if (b.pts[k] > 0) return false; }
  else { for (let k = 18; k <= i - 1; k++) if (b.pts[k] < 0) return false; }
  return true;
}

// All single-checker moves colour c can make with ONE die value on board b. If c has checkers on the
// bar it MUST enter them first, so only bar-entry moves are generated. Each move is
// { from: 'bar'|index, to: 'off'|index, die, hit:boolean, bear:boolean }.
function singleMoves(b, c, die) {
  const out = [];
  if (bar(b, c) > 0) {
    const dest = c === WHITE ? 24 - die : die - 1; // enter into the opponent's home board
    if (dest >= 0 && dest <= 23 && canLand(b, c, dest))
      out.push({ from: 'bar', to: dest, die, hit: isBlot(b, c, dest), bear: false });
    return out;
  }
  for (let i = 0; i < 24; i++) {
    const v = b.pts[i];
    const mine = c === WHITE ? v > 0 : v < 0;
    if (!mine) continue;
    const dest = c === WHITE ? i - die : i + die;
    const overEdge = c === WHITE ? dest < 0 : dest > 23;
    if (overEdge) {
      if (allHome(b, c) && canBearOff(b, c, i, die))
        out.push({ from: i, to: 'off', die, hit: false, bear: true });
    } else if (canLand(b, c, dest)) {
      out.push({ from: i, to: dest, die, hit: isBlot(b, c, dest), bear: false });
    }
  }
  return out;
}

// Apply a single move to a board, returning a NEW board (used during enumeration/search).
function withMove(b, c, m) {
  const n = cloneBoard(b);
  applyInPlace(n, c, m);
  return n;
}
// Mutating apply — used on the live game board.
function applyInPlace(b, c, m) {
  if (m.from === 'bar') { if (c === WHITE) b.barW--; else b.barB--; }
  else b.pts[m.from] += c === WHITE ? -1 : 1;

  if (m.to === 'off') { if (c === WHITE) b.offW++; else b.offB++; return; }
  if (m.hit) { b.pts[m.to] = 0; if (c === WHITE) b.barB++; else b.barW++; }
  b.pts[m.to] += c === WHITE ? 1 : -1;
}

// Enumerate every maximal legal move-SEQUENCE for colour c given the multiset of remaining dice.
// Returns an array of sequences (each an array of move objects). A sequence is "maximal" only in the
// sense that it stops when no further move is possible; the caller then applies the use-most-dice and
// larger-die rules. A soft cap guards against pathological blow-ups (never reached in real play).
function enumerateSequences(b, c, dice) {
  const leaves = [];
  const CAP = 200000;
  const recur = (board, remaining, path) => {
    if (leaves.length > CAP) return;
    let extended = false;
    const triedValues = new Set();
    for (let idx = 0; idx < remaining.length; idx++) {
      const d = remaining[idx];
      if (triedValues.has(d)) continue; // identical die values give identical options
      triedValues.add(d);
      const moves = singleMoves(board, c, d);
      for (const m of moves) {
        extended = true;
        const rest = remaining.slice();
        rest.splice(idx, 1);
        recur(withMove(board, c, m), rest, path.concat(m));
      }
    }
    if (!extended) leaves.push(path);
  };
  recur(b, dice.slice(), []);
  return leaves;
}

// The set of legal move-sequences a player is actually ALLOWED to choose from, after applying:
//   • use as many dice as legally possible (keep only the longest sequences), and
//   • if you can play only one of two unequal dice, you must play the LARGER.
function canonicalSequences(b, c, remainingDice) {
  if (remainingDice.length === 0) return [];
  const leaves = enumerateSequences(b, c, remainingDice);
  let maxLen = 0;
  for (const s of leaves) if (s.length > maxLen) maxLen = s.length;
  if (maxLen === 0) return [];
  let keep = leaves.filter((s) => s.length === maxLen);

  // Larger-die rule: only bites when exactly one of two DIFFERENT dice can be played.
  if (maxLen === 1 && remainingDice.length === 2 && remainingDice[0] !== remainingDice[1]) {
    const bigger = Math.max(remainingDice[0], remainingDice[1]);
    const usesBigger = keep.filter((s) => s[0].die === bigger);
    if (usesBigger.length) keep = usesBigger;
  }

  // De-duplicate sequences that reach an identical final position (keeps AI search lean); the set of
  // legal FIRST moves is unaffected because those are compared separately by the callers.
  const seen = new Set();
  const uniq = [];
  for (const s of keep) {
    let board = b;
    for (const m of s) board = withMove(board, c, m);
    const key = boardKey(board);
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(s);
  }
  return uniq;
}

// ---- AI evaluation ---------------------------------------------------------------------------
// Score a resulting board from `me`'s point of view (higher = better). Pip lead dominates; blots are
// penalised by how easily the opponent can hit them; made points (especially at home) and a prime
// help; checkers on the bar hurt; borne-off checkers are gold. `deep` adds shot-accurate blot weights
// and a prime bonus for the harder levels.
function shotDistance(b, blot, opp) {
  // Minimum pips an opponent checker (or one entering from the bar) needs to reach `blot`.
  let best = 99;
  if (bar(b, opp) > 0) {
    // Entry lands at 24-die (white) or die-1 (black); nearest reachable entry to the blot.
    const d = opp === WHITE ? 24 - blot : blot + 1;
    if (d >= 1 && d <= 24) best = Math.min(best, d);
  }
  for (let j = 0; j < 24; j++) {
    const v = b.pts[j];
    const theirs = opp === WHITE ? v > 0 : v < 0;
    if (!theirs) continue;
    const dist = opp === WHITE ? j - blot : blot - j; // opponent must travel in its own direction
    if (dist >= 1 && dist < best) best = dist;
  }
  return best;
}
function primeLength(b, c) {
  let best = 0, run = 0;
  for (let i = 0; i < 24; i++) {
    const v = b.pts[i];
    const made = c === WHITE ? v >= 2 : v <= -2;
    run = made ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
}
function evaluate(b, me, deep) {
  const opp = other(me);
  let score = pipCount(b, opp) - pipCount(b, me);
  score += (me === WHITE ? b.offW : b.offB) * 14;
  score -= bar(b, me) * 26;
  score += bar(b, opp) * 12;

  let points = 0, homePoints = 0;
  for (let i = 0; i < 24; i++) {
    const v = b.pts[i];
    if (v === 0) continue;
    const mine = me === WHITE ? v > 0 : v < 0;
    if (!mine) continue;
    const cnt = Math.abs(v);
    if (cnt >= 2) { points++; if (inHome(me, i)) homePoints++; }
    else {
      const d = shotDistance(b, i, opp);
      const w = d >= 1 && d <= 24 ? SHOTS[d] : 0;
      score -= (deep ? w * 0.5 : w * 0.28);
    }
  }
  score += points * 3 + homePoints * 4;
  if (deep) score += primeLength(b, me) * 2.5;
  return score;
}

// ---------------------------------------------------------------------------------------------
export function createBackgammon() {
  let board = freshBoard();
  let turn = WHITE;
  let dice = [];        // the full rolled dice for display: [d1,d2] or [d,d,d,d] on doubles
  let movesLeft = [];   // die values not yet consumed this turn
  let rolled = false;   // has the current player rolled yet?
  const history = [];   // per-move snapshots for undo within the current turn

  const engine = {
    // Restart to the standard opening position with white to roll.
    reset() {
      board = freshBoard();
      turn = WHITE;
      dice = [];
      movesLeft = [];
      rolled = false;
      history.length = 0;
    },

    turn: () => turn,

    // Load an arbitrary position (for tests, puzzles or resuming a saved game). `pos` mirrors the
    // shape of state(): { points:[{count,color}...], bar:{w,b}, off:{w,b}, turn }. Clears any dice.
    setup(pos) {
      const b = { pts: new Int8Array(24), barW: 0, barB: 0, offW: 0, offB: 0 };
      (pos.points || []).forEach((p, i) => {
        if (!p || !p.count) return;
        b.pts[i] = p.color === WHITE ? p.count : -p.count;
      });
      if (pos.bar) { b.barW = pos.bar.w | 0; b.barB = pos.bar.b | 0; }
      if (pos.off) { b.offW = pos.off.w | 0; b.offB = pos.off.b | 0; }
      board = b;
      turn = pos.turn || WHITE;
      dice = [];
      movesLeft = [];
      rolled = false;
      history.length = 0;
    },

    // Encode the CURRENT position (board + turn, no dice) as a short URL-safe share token. See the
    // codec block above: mid-turn dice/partial-move state is intentionally dropped so the recipient
    // gets a clean "your roll" position; the board itself is captured exactly as it stands.
    serialize() {
      return serializeBoard(board, turn);
    },

    // Restore from a share token. Returns true on success, false for a malformed or checker-count-
    // inconsistent token (leaving the current game untouched on failure).
    deserialize(token) {
      const parsed = parseToken(token);
      if (!parsed) return false;
      board = { pts: parsed.pts, barW: parsed.barW, barB: parsed.barB, offW: parsed.offW, offB: parsed.offB };
      turn = parsed.turn;
      dice = [];
      movesLeft = [];
      rolled = false;
      history.length = 0;
      return true;
    },

    // Public snapshot consumed by the view. `points[i] = {count, color:'w'|'b'|null}`.
    state() {
      const points = [];
      for (let i = 0; i < 24; i++) {
        const v = board.pts[i];
        points.push(v === 0 ? { count: 0, color: null } : { count: Math.abs(v), color: v > 0 ? WHITE : BLACK });
      }
      return {
        points,
        bar: { w: board.barW, b: board.barB },
        off: { w: board.offW, b: board.offB },
        turn,
        dice: dice.slice(),
        movesLeft: movesLeft.slice(),
        rolled,
      };
    },

    pip: (color) => pipCount(board, color),

    // Roll for the current player. Pass explicit dice for determinism (tests); otherwise random 1..6.
    // Returns { d1, d2, dice, canMove } — canMove:false means the turn has no legal play and should
    // be auto-passed by the caller (via endTurn()).
    roll(d1, d2) {
      if (d1 == null) d1 = 1 + Math.floor(Math.random() * 6);
      if (d2 == null) d2 = 1 + Math.floor(Math.random() * 6);
      dice = d1 === d2 ? [d1, d1, d1, d1] : [d1, d2];
      movesLeft = dice.slice();
      rolled = true;
      history.length = 0;
      const canMove = engine.canMove();
      return { d1, d2, dice: dice.slice(), canMove };
    },

    // Legal single moves available RIGHT NOW (the first move of some allowed sequence), de-duplicated
    // by (from → to). Each entry: { from, to, die, hit, bear }.
    allLegalMoves() {
      const seqs = canonicalSequences(board, turn, movesLeft);
      const map = new Map();
      for (const s of seqs) {
        if (!s.length) continue;
        const m = s[0];
        map.set(`${m.from}>${m.to}`, { from: m.from, to: m.to, die: m.die, hit: m.hit, bear: m.bear });
      }
      return [...map.values()];
    },

    // Legal destinations for a given source ('bar' or a point index) — for highlighting.
    legalMovesFrom(src) {
      return engine.allLegalMoves().filter((m) => m.from === src);
    },

    canMove() {
      return engine.allLegalMoves().length > 0;
    },

    // Apply one checker move, chosen by { from, to } or { from, die }. Consumes the matching die,
    // resolves hits/bar/bear-off, and records an undo point. Returns { ok, hit, boreOff }.
    move(arg) {
      const legal = engine.allLegalMoves();
      let m = null;
      if (arg && arg.to !== undefined) m = legal.find((x) => x.from === arg.from && x.to === arg.to);
      else if (arg && arg.die !== undefined) m = legal.find((x) => x.from === arg.from && x.die === arg.die);
      if (!m) return { ok: false, hit: false, boreOff: false };

      history.push({ board: cloneBoard(board), movesLeft: movesLeft.slice() });
      applyInPlace(board, turn, m);
      const di = movesLeft.indexOf(m.die);
      if (di >= 0) movesLeft.splice(di, 1);
      return { ok: true, hit: !!m.hit, boreOff: m.to === 'off' };
    },

    // Undo the last checker move made this turn. Returns true if something was undone.
    undo() {
      const snap = history.pop();
      if (!snap) return false;
      board = snap.board;
      movesLeft = snap.movesLeft;
      return true;
    },

    // Pass the turn to the opponent. Only allowed when the player is out of legal moves (or has used
    // every die). Returns true on success.
    endTurn() {
      if (rolled && movesLeft.length > 0 && engine.canMove()) return false;
      turn = other(turn);
      dice = [];
      movesLeft = [];
      rolled = false;
      history.length = 0;
      return true;
    },

    status() {
      if (board.offW === 15) return { over: true, winner: WHITE, reason: 'White bore off all 15 checkers' };
      if (board.offB === 15) return { over: true, winner: BLACK, reason: 'Black bore off all 15 checkers' };
      return { over: false, winner: null, reason: '' };
    },

    // Given dice ALREADY rolled for the current (AI) player, return an ORDERED list of single moves
    // — a full legal sequence — for the view to apply one at a time. level: 'easy'|'medium'|'hard'.
    // 'easy' picks a decent-but-random sequence; 'medium'/'hard' pick the best by evaluation, 'hard'
    // using the richer eval. Returns [] when there is nothing to play.
    aiTurn(level = 'medium') {
      const seqs = canonicalSequences(board, turn, movesLeft);
      if (!seqs.length) return [];
      const me = turn;
      const deep = level === 'hard';
      const scored = seqs.map((seq) => {
        let b = board;
        for (const m of seq) b = withMove(b, me, m);
        return { seq, score: evaluate(b, me, deep) };
      });
      scored.sort((a, b) => b.score - a.score);

      let chosen;
      if (level === 'easy') {
        // Wander into the top band rather than always the best line, so easy feels beatable.
        const band = Math.max(1, Math.ceil(scored.length * 0.5));
        chosen = scored[Math.floor(Math.random() * band)].seq;
      } else {
        const best = scored[0].score;
        const ties = scored.filter((s) => s.score >= best - 1e-9);
        chosen = ties[Math.floor(Math.random() * ties.length)].seq;
      }
      return chosen.map((m) => ({ from: m.from, to: m.to, die: m.die, hit: !!m.hit, bear: !!m.bear }));
    },
  };

  engine.reset();
  return engine;
}

export default createBackgammon;
