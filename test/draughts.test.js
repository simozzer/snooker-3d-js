// draughts.test.js — English draughts engine: setup, forced/multi captures, crowning, king
// movement, win detection, and AI legality. Deterministic (custom positions via engine.load()).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDraughts } from '../src/board/draughts.js';

// Build an 8x8 char grid from an object of "row,col": char entries; blanks elsewhere.
function grid(entries) {
  const g = Array.from({ length: 8 }, () => '.'.repeat(8).split(''));
  for (const [k, ch] of Object.entries(entries)) {
    const [r, c] = k.split(',').map(Number);
    g[r][c] = ch;
  }
  return g.map((row) => row.join(''));
}

const dest = (m) => m.path[m.path.length - 1];
const isLegal = (d, m) => d.allLegalMoves().some((lm) =>
  lm.from.row === m.from.row && lm.from.col === m.from.col &&
  dest(lm).row === dest(m).row && dest(lm).col === dest(m).col &&
  lm.captures.length === m.captures.length);

test('initial position: 12 v 12 pieces, red to move with exactly 7 opening moves', () => {
  const d = createDraughts();
  const b = d.board();
  let r = 0, w = 0;
  for (let row = 0; row < 8; row++)
    for (let col = 0; col < 8; col++) {
      const p = b[row][col];
      if (p) (p.color === 'r' ? r++ : w++);
    }
  assert.equal(r, 12);
  assert.equal(w, 12);
  assert.equal(d.turn(), 'r');
  assert.equal(d.allLegalMoves().length, 7);
});

test('forced capture: a non-capturing move is rejected when a capture exists', () => {
  const d = createDraughts();
  // Red man at (5,2) can jump the white at (4,3) landing on empty (3,4).
  // An unrelated red man at (7,0) also has a quiet step to (6,1) — which must be illegal.
  d.load(grid({ '5,2': 'r', '4,3': 'w', '7,0': 'r' }), 'r');

  const all = d.allLegalMoves();
  assert.ok(all.length > 0);
  assert.ok(all.every((m) => m.captures.length === 1), 'only captures are offered');

  const quiet = d.move({ from: { row: 7, col: 0 }, path: [{ row: 6, col: 1 }], captures: [] });
  assert.equal(quiet.ok, false, 'quiet move rejected under forced capture');

  const cap = d.move({ from: { row: 5, col: 2 }, path: [{ row: 3, col: 4 }], captures: [{ row: 4, col: 3 }] });
  assert.equal(cap.ok, true);
  assert.equal(cap.captures.length, 1);
  assert.equal(d.board()[4][3], null, 'jumped white removed');
  assert.equal(d.turn(), 'w');
});

test('multi-jump: a single move chains two captures for the same piece', () => {
  const d = createDraughts();
  // Red (5,2) jumps (4,3)->(3,4) then (2,3)->(1,2): a forced double.
  d.load(grid({ '5,2': 'r', '4,3': 'w', '2,3': 'w' }), 'r');

  const moves = d.allLegalMoves();
  const dbl = moves.find((m) => m.captures.length === 2);
  assert.ok(dbl, 'a two-capture chain is generated');
  assert.deepEqual(dest(dbl), { row: 1, col: 2 });

  const res = d.move(dbl);
  assert.equal(res.ok, true);
  assert.equal(res.captures.length, 2);
  const b = d.board();
  assert.equal(b[4][3], null);
  assert.equal(b[2][3], null);
  assert.equal(b[1][2].color, 'r');
});

test('crowning ends the move: a man reaching the back rank kings and does not chain', () => {
  const d = createDraughts();
  // Red (2,1) jumps white (1,2) landing on the crown row (0,3). A king could then jump the
  // white at (1,4) onto (2,5), but crowning must END the move — so only a one-capture move exists.
  d.load(grid({ '2,1': 'r', '1,2': 'w', '1,4': 'w' }), 'r');

  const moves = d.allLegalMoves();
  assert.ok(moves.every((m) => m.captures.length === 1), 'no chaining past the crown row');
  const crowner = moves.find((m) => dest(m).row === 0 && dest(m).col === 3);
  assert.ok(crowner);
  assert.equal(crowner.crown, true);

  const res = d.move(crowner);
  assert.equal(res.ok, true);
  assert.equal(res.crowned, true);
  const b = d.board();
  assert.equal(b[0][3].king, true, 'landed piece is a king');
  assert.ok(b[1][4] && b[1][4].color === 'w', 'the second white survives (no king chain)');
  assert.equal(d.turn(), 'w');
});

test('kings move and capture backward', () => {
  const d = createDraughts();
  // Red KING at (4,3); a white man at (5,4) is "behind" red. King must be able to move backward
  // and to capture backward (5,4)->(6,5).
  d.load(grid({ '4,3': 'R', '5,4': 'w' }), 'r');

  const moves = d.allLegalMoves();
  // Forced capture: the backward jump is the only offered move.
  assert.ok(moves.every((m) => m.captures.length === 1));
  const back = moves.find((m) => dest(m).row === 6 && dest(m).col === 5);
  assert.ok(back, 'king captures backward');

  const res = d.move(back);
  assert.equal(res.ok, true);
  assert.equal(d.board()[5][4], null);

  // Without a capture available, a king still has backward steps.
  const d2 = createDraughts();
  d2.load(grid({ '4,3': 'R' }), 'r');
  const steps = d2.allLegalMoves();
  assert.ok(steps.some((m) => dest(m).row === 5), 'king can step backward (downward)');
  assert.ok(steps.some((m) => dest(m).row === 3), 'king can step forward (upward)');
});

test('win detection: the side to move with no pieces has lost', () => {
  const d = createDraughts();
  d.load(grid({ '5,2': 'r', '6,1': 'r' }), 'w'); // white to move, white has no pieces
  const s = d.status();
  assert.equal(s.over, true);
  assert.equal(s.winner, 'r');
  assert.equal(s.result, 'win');
});

test('win detection: the side to move with no legal move has lost (blocked)', () => {
  const d = createDraughts();
  // Lone white man at (0,7) can only step to (1,6); block it with a red man backed by another red
  // so no capture is possible either. White to move => white loses.
  d.load(grid({ '0,7': 'w', '1,6': 'r', '2,5': 'r' }), 'w');
  assert.equal(d.allLegalMoves().length, 0);
  const s = d.status();
  assert.equal(s.over, true);
  assert.equal(s.winner, 'r');
});

test('aiMove returns a legal move at every difficulty', () => {
  for (const level of ['easy', 'medium', 'hard']) {
    const d = createDraughts();
    const m = d.aiMove(level);
    assert.ok(m, `${level} returns a move`);
    assert.ok(isLegal(d, m), `${level} move is legal`);
  }
});

test('aiMove picks the forced capture when one exists', () => {
  const d = createDraughts();
  d.load(grid({ '5,2': 'r', '4,3': 'w' }), 'r');
  const m = d.aiMove('hard');
  assert.ok(m);
  assert.equal(m.captures.length, 1);
});

test('serialize produces a stable, non-empty token for the start position', () => {
  const d = createDraughts();
  const t = d.serialize();
  assert.equal(typeof t, 'string');
  assert.ok(t.length >= 34, 'token is 32 cells + turn + counter');
  assert.equal(t, createDraughts().serialize(), 'deterministic for the same position');
  assert.match(t, /^[.rRwW]{32}[rw]\d+$/, 'token uses only URL-safe codec characters');
});

test('serialize/deserialize round-trips a mid-game position (incl. a capture)', () => {
  const d = createDraughts();
  d.load(grid({ '5,2': 'r', '4,3': 'w', '7,0': 'r', '0,7': 'w' }), 'r');
  d.move({ from: { row: 5, col: 2 }, path: [{ row: 3, col: 4 }], captures: [{ row: 4, col: 3 }] });
  const token = d.serialize();

  const d2 = createDraughts();
  assert.equal(d2.deserialize(token), true);
  assert.deepEqual(d2.board(), d.board(), 'board matches after round-trip');
  assert.equal(d2.turn(), d.turn());
  assert.equal(d2.serialize(), token, 'the reloaded position re-serializes identically');
});

test('a crowned king survives the round-trip', () => {
  const d = createDraughts();
  d.load(grid({ '2,1': 'r', '1,2': 'w' }), 'r');
  const res = d.move({ from: { row: 2, col: 1 }, path: [{ row: 0, col: 3 }], captures: [{ row: 1, col: 2 }] });
  assert.equal(res.crowned, true);
  const token = d.serialize();

  const d2 = createDraughts();
  assert.equal(d2.deserialize(token), true);
  const p = d2.board()[0][3];
  assert.ok(p && p.color === 'r' && p.king === true, 'king restored as a king');
});

test('deserialize rejects malformed tokens', () => {
  const d = createDraughts();
  const good = d.serialize();
  assert.equal(d.deserialize('garbage'), false);
  assert.equal(d.deserialize(''), false);
  assert.equal(d.deserialize(null), false);
  assert.equal(d.deserialize(good.slice(0, 20)), false, 'too short');
  assert.equal(d.deserialize('x'.repeat(32) + 'r0'), false, 'bad cell characters');
  assert.equal(d.deserialize(good.slice(0, 32) + 'z0'), false, 'bad turn char');
  assert.equal(d.deserialize(good.slice(0, 33) + 'xx'), false, 'non-numeric counter');
  assert.equal(d.deserialize(good), true, 'the valid token still loads');
});

test('undo restores prior positions across at least two plies', () => {
  const d = createDraughts();
  const before = JSON.stringify(d.board());
  const m1 = d.allLegalMoves()[0];
  d.move(m1);
  const m2 = d.allLegalMoves()[0];
  d.move(m2);
  assert.equal(d.history().length, 2);
  assert.equal(d.undo(), true);
  assert.equal(d.undo(), true);
  assert.equal(JSON.stringify(d.board()), before, 'back to the initial position');
  assert.equal(d.turn(), 'r');
  assert.equal(d.history().length, 0);
});
