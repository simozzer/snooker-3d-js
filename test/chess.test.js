// test/chess.test.js — unit tests for the pure chess engine (src/board/chess.js). No DOM, deterministic.
// Coordinates follow the engine's public convention: {file:0..7 (a..h), rank:0..7 (ranks 1..8)}.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChess } from '../src/board/chess.js';

// Helpers to talk in algebraic squares (e.g. 'e2') instead of raw indices.
const FILES = 'abcdefgh';
const sq = (s) => ({ file: FILES.indexOf(s[0]), rank: Number(s[1]) - 1 });
const mv = (from, to, promotion) => ({ from: sq(from), to: sq(to), promotion });

// Play a list of "e2e4" style moves, asserting each is accepted.
function playAll(chess, moves) {
  for (const s of moves) {
    const r = chess.move(mv(s.slice(0, 2), s.slice(2, 4), s[4]));
    assert.ok(r.ok, `expected ${s} to be legal`);
  }
}

test('initial position has exactly 20 legal moves', () => {
  const chess = createChess();
  assert.equal(chess.allLegalMoves().length, 20);
  assert.equal(chess.turn(), 'w');
});

test('board() layout: a1 rook, e1 white king, e8 black king, e4 empty', () => {
  const chess = createChess();
  const b = chess.board(); // b[rank][file], rank 0 = rank 1
  assert.deepEqual(b[0][0], { type: 'r', color: 'w' });
  assert.deepEqual(b[0][4], { type: 'k', color: 'w' });
  assert.deepEqual(b[7][4], { type: 'k', color: 'b' });
  assert.equal(b[3][4], null);
});

test("fool's mate reaches checkmate", () => {
  const chess = createChess();
  playAll(chess, ['f2f3', 'e7e5', 'g2g4', 'd8h4']);
  const st = chess.status();
  assert.ok(st.over);
  assert.equal(st.result, 'checkmate');
  assert.equal(st.winner, 'b');
  assert.ok(st.inCheck);
});

test("scholar's mate reaches checkmate (White wins)", () => {
  const chess = createChess();
  playAll(chess, ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6', 'h5f7']);
  const st = chess.status();
  assert.ok(st.over);
  assert.equal(st.result, 'checkmate');
  assert.equal(st.winner, 'w');
});

test('illegal moves are rejected', () => {
  const chess = createChess();
  assert.equal(chess.move(mv('e2', 'e5')).ok, false); // pawn can't jump 3
  assert.equal(chess.move(mv('e1', 'e2')).ok, false); // king blocked by own pawn
  assert.equal(chess.move(mv('a1', 'a4')).ok, false); // rook blocked by own pawn
  assert.equal(chess.move(mv('d1', 'd3')).ok, false); // queen blocked
  assert.equal(chess.turn(), 'w'); // nothing was applied
});

test('kingside castling works and updates both pieces', () => {
  const chess = createChess();
  // Clear the king's bishop + knight, then castle.
  playAll(chess, ['e2e4', 'e7e5', 'g1f3', 'g8f6', 'f1c4', 'f8c5']);
  const r = chess.move(mv('e1', 'g1'));
  assert.ok(r.ok);
  assert.ok(r.flags.includes('k'));
  const b = chess.board();
  assert.deepEqual(b[0][6], { type: 'k', color: 'w' }); // king on g1
  assert.deepEqual(b[0][5], { type: 'r', color: 'w' }); // rook hopped to f1
  assert.equal(b[0][7], null);                          // h1 vacated
});

test('castling is illegal through an attacked square', () => {
  const chess = createChess();
  // Manoeuvre a black knight to g3, where it attacks f1 — the square the White king must pass through
  // to castle kingside. White has cleared f1 (Bc4) and g1 (Nf3), so only the "through check" rule forbids it.
  playAll(chess, ['e2e4', 'g8f6', 'g1f3', 'f6e4', 'f1c4', 'e4g3']);
  const kingMoves = chess.legalMovesFrom(sq('e1')).map((m) => `${FILES[m.to.file]}${m.to.rank + 1}`);
  assert.ok(!kingMoves.includes('g1'), 'O-O should be blocked while the king would pass through f1 (attacked by Ng3)');
});

test('castling is blocked when squares are occupied', () => {
  const chess = createChess();
  // Right at the start the king cannot castle (pieces in the way).
  const kingMoves = chess.legalMovesFrom(sq('e1'));
  assert.equal(kingMoves.length, 0);
});

test('en passant capture works', () => {
  const chess = createChess();
  // Get a White pawn to e5, then Black plays d7-d5; White captures exd6 e.p.
  playAll(chess, ['e2e4', 'a7a6', 'e4e5', 'd7d5']);
  const r = chess.move(mv('e5', 'd6'));
  assert.ok(r.ok);
  assert.ok(r.flags.includes('e'));
  const b = chess.board();
  assert.deepEqual(b[5][3], { type: 'p', color: 'w' }); // white pawn now on d6
  assert.equal(b[4][3], null);                          // captured black pawn on d5 is gone
});

// Shared setup: march a White pawn to a7, poised to promote by capturing the b8 knight (a7-a8 would be
// blocked by the black rook still sitting on a8, so we promote on the capture).
const PROMO_SETUP = ['a2a4', 'b7b5', 'a4b5', 'a7a6', 'b5a6', 'h7h6', 'a6a7', 'h6h5'];

test('pawn promotion auto-queens (and honours an explicit choice)', () => {
  const chess = createChess();
  playAll(chess, PROMO_SETUP);
  const r = chess.move(mv('a7', 'b8')); // capture-promotion, default = queen
  assert.ok(r.ok);
  assert.ok(r.flags.includes('p'));
  assert.equal(chess.board()[7][1].type, 'q'); // queen now on b8
});

test('explicit underpromotion to knight', () => {
  const chess = createChess();
  playAll(chess, PROMO_SETUP);
  const r = chess.move(mv('a7', 'b8', 'n'));
  assert.ok(r.ok);
  assert.equal(chess.board()[7][1].type, 'n');
});

test('stalemate is detected on a classic position', () => {
  // Black to move, king on a8, White king c7 + queen b6 wait... use the well-known:
  // White: Kf7 (e6?), simplest known stalemate — Black king h8, White king g6? no. Use a verified one:
  // Black king a8, White queen c7?, that's mate. Reliable stalemate: Black Ka8; White Kc7? no.
  // Use: Black to move, only king on h1; White king f2, queen g3 -> stalemate.
  const chess = createChess();
  // We can't set FEN, so reach a stalemate by playing a known short line into it.
  // Known stalemate line (Sam Loyd-ish): 1.e3 a5 2.Qh5 Ra6 3.Qxa5 h5 4.Qxc7 Rah6 5.h4 f6
  // 6.Qxd7+ Kf7 7.Qxb7 Qd3 8.Qxb8 Qh7 9.Qxc8 Kg6 10.Qe6 -> Black is stalemated.
  playAll(chess, [
    'e2e3', 'a7a5', 'd1h5', 'a8a6', 'h5a5', 'h7h5', 'a5c7', 'a6h6', 'h2h4', 'f7f6',
    'c7d7', 'e8f7', 'd7b7', 'd8d3', 'b7b8', 'd3h7', 'b8c8', 'f7g6', 'c8e6',
  ]);
  const st = chess.status();
  assert.ok(st.over, 'game should be over');
  assert.equal(st.result, 'stalemate');
  assert.equal(st.inCheck, false);
});

test('undo reverts the last move (supports at least 2 levels)', () => {
  const chess = createChess();
  playAll(chess, ['e2e4', 'e7e5']);
  assert.equal(chess.history().length, 2);
  chess.undo();
  assert.equal(chess.turn(), 'b');
  assert.equal(chess.history().length, 1);
  chess.undo();
  assert.equal(chess.turn(), 'w');
  assert.equal(chess.history().length, 0);
  // Board must be back to the start (20 legal moves again).
  assert.equal(chess.allLegalMoves().length, 20);
});

test('aiMove returns a legal move from the start position without applying it', () => {
  const chess = createChess();
  for (const level of ['easy', 'medium', 'hard']) {
    const m = chess.aiMove(level);
    assert.ok(m, `${level} should return a move`);
    // The returned move must be one of the legal moves, and the position is untouched.
    const legal = chess.allLegalMoves();
    const found = legal.some((x) =>
      x.from.file === m.from.file && x.from.rank === m.from.rank &&
      x.to.file === m.to.file && x.to.rank === m.to.rank);
    assert.ok(found, `${level} move must be legal`);
    assert.equal(chess.history().length, 0, 'aiMove must not apply the move');
    assert.equal(chess.turn(), 'w');
  }
});

test('medium/hard aiMove is deterministic for a given position', () => {
  const a = createChess();
  const b = createChess();
  assert.deepEqual(a.aiMove('medium'), b.aiMove('medium'));
  assert.deepEqual(a.aiMove('hard'), b.aiMove('hard'));
});

test('hard aiMove stays within a sane time budget from the opening', () => {
  const chess = createChess();
  const t0 = Date.now();
  chess.aiMove('hard');
  const dt = Date.now() - t0;
  assert.ok(dt < 2000, `hard search took ${dt}ms (expected < 2000)`);
});

test('threefold repetition is detected', () => {
  const chess = createChess();
  // Shuffle both knights back and forth to repeat the start position a third time.
  playAll(chess, [
    'g1f3', 'g8f6', 'f3g1', 'f6g8', // back to start (2nd occurrence)
    'g1f3', 'g8f6', 'f3g1', 'f6g8', // back to start (3rd occurrence)
  ]);
  const st = chess.status();
  assert.ok(st.over);
  assert.equal(st.result, 'draw');
});

test('fen() of the start position is the standard start FEN', () => {
  const chess = createChess();
  assert.equal(chess.fen(), 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
});

test('FEN round-trips a mid-game position (board, turn, castling, ep)', () => {
  const a = createChess();
  playAll(a, ['e2e4', 'c7c5', 'g1f3', 'd7d6', 'f1c4']);
  const fen = a.fen();
  const b = createChess();
  assert.ok(b.loadFEN(fen), 'loadFEN should accept a valid FEN');
  assert.equal(b.fen(), fen);                 // exact string round-trip
  assert.deepEqual(b.board(), a.board());     // identical placement
  assert.equal(b.turn(), a.turn());            // same side to move
  // Agreeing on the full legal-move set is a strong proxy for identical castling/ep state.
  assert.equal(b.allLegalMoves().length, a.allLegalMoves().length);
});

test('en-passant target survives a FEN round-trip', () => {
  const a = createChess();
  // 1.e4 a6 2.e5 d5 — Black's double push sets the d6 en-passant square for White.
  playAll(a, ['e2e4', 'a7a6', 'e4e5', 'd7d5']);
  const fen = a.fen();
  assert.match(fen, / d6 /, 'en-passant target d6 should appear in the FEN');
  const b = createChess();
  assert.ok(b.loadFEN(fen));
  const r = b.move(mv('e5', 'd6')); // the e.p. capture must still be legal after reloading
  assert.ok(r.ok);
  assert.ok(r.flags.includes('e'));
});

test('castling rights survive a FEN round-trip', () => {
  const a = createChess();
  // Move the h1 rook out and back so White loses only the kingside right; Black keeps both.
  playAll(a, ['g1f3', 'g8f6', 'h1g1', 'a7a6', 'g1h1', 'a6a5']);
  const fen = a.fen();
  assert.equal(fen.split(' ')[2], 'Qkq', 'White should have lost only its kingside right');
  const b = createChess();
  assert.ok(b.loadFEN(fen));
  assert.equal(b.fen().split(' ')[2], 'Qkq');
});

test('loadFEN rejects garbage without mutating state', () => {
  const chess = createChess();
  const before = chess.fen();
  for (const bad of [
    '', 'not a fen',
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq', // too few fields
    'xxxxxxxx/8/8/8/8/8/8/8 w - - 0 1',                   // illegal piece letters
    '8/8/8/8/8/8/8/8 w - - 0 1',                          // no kings
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR z KQkq - 0 1', // bad side letter
    'rnbqkbnr/pppppppp/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',   // only 7 ranks
  ]) {
    assert.equal(chess.loadFEN(bad), false, `should reject: ${bad}`);
  }
  assert.equal(chess.fen(), before, 'a rejected FEN must not mutate the position');
});

test('insufficient material (K vs K) is a draw — via FEN', () => {
  const chess = createChess();
  assert.ok(chess.loadFEN('8/8/4k3/8/8/3K4/8/8 w - - 0 1')); // bare kings
  const st = chess.status();
  assert.ok(st.over);
  assert.equal(st.result, 'draw');
  assert.match(st.reason, /insufficient material/);
  // A lone king + knight versus king is also a draw; a king + rook is NOT.
  assert.ok(chess.loadFEN('8/8/4k3/8/8/3K1N2/8/8 w - - 0 1'));
  assert.equal(chess.status().result, 'draw');
  assert.ok(chess.loadFEN('8/8/4k3/8/8/3K1R2/8/8 w - - 0 1'));
  assert.equal(chess.status().over, false);
});
