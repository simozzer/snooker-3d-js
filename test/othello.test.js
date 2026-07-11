import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOthello } from '../src/board/othello.js';

const at = (e, r, c) => e.board()[r][c];

test('opening position: 2–2, Black to move, four legal moves', () => {
  const e = createOthello();
  assert.equal(e.turn(), 'b');
  assert.deepEqual(e.counts(), { b: 2, w: 2 });
  const moves = e.legalMoves();
  assert.equal(moves.length, 4);
  // the four classic openings around the centre
  const set = new Set(moves.map((m) => `${m.r},${m.c}`));
  for (const k of ['2,3', '3,2', '4,5', '5,4']) assert.ok(set.has(k), `missing opening ${k}`);
});

test('a legal move places a disc and flips the flanked line; illegal is rejected', () => {
  const e = createOthello();
  const res = e.move({ r: 2, c: 3 }); // Black flanks white d4
  assert.ok(res.ok);
  assert.equal(at(e, 2, 3), 'b'); // placed
  assert.equal(at(e, 3, 3), 'b'); // flipped (was white)
  assert.deepEqual(e.counts(), { b: 4, w: 1 });
  assert.equal(e.turn(), 'w');
  // an empty square that flanks nothing is illegal
  assert.equal(e.move({ r: 0, c: 0 }).ok, false);
  // an occupied square is illegal
  assert.equal(e.move({ r: 3, c: 3 }).ok, false);
});

test('undo restores the board, the flipped discs, and the turn', () => {
  const e = createOthello();
  const before = e.serialize();
  e.move({ r: 2, c: 3 });
  assert.notEqual(e.serialize(), before);
  assert.ok(e.undo());
  assert.equal(e.serialize(), before);
  assert.equal(e.turn(), 'b');
  assert.equal(e.undo(), false); // nothing left
});

test('auto-pass: an opponent with no reply is skipped, handing the turn back', () => {
  const e = createOthello();
  // Two white discs, each boxed so White can never move; Black can play at (0,0) or (2,0). After Black
  // plays (0,0), White still has no move but Black does → the turn must pass back to Black.
  const tok =
    '.wbbbbbb' + 'bbbbbbbb' + '.wbbbbbb' + 'bbbbbbbb' +
    'bbbbbbbb' + 'bbbbbbbb' + 'bbbbbbbb' + 'bbbbbbbb' + 'b';
  assert.ok(e.deserialize(tok));
  assert.equal(e.legalMoves().length, 2);
  assert.ok(e.move({ r: 0, c: 0 }).ok);
  assert.equal(e.status().over, false);
  assert.equal(e.turn(), 'b', 'White had no reply → turn passed back to Black');
});

test('invariant: the side to move always has a legal move until the game is over', () => {
  // The auto-pass guarantee, checked across many self-played games: move() never lands the turn on a
  // player who cannot move — it passes them — so legalMoves() is non-empty until status().over.
  for (let game = 0; game < 12; game++) {
    const e = createOthello();
    let plies = 0;
    while (!e.status().over && plies < 100) {
      assert.ok(e.legalMoves().length > 0, 'side to move has no legal move yet the game is not over');
      assert.ok(e.move(e.aiMove('medium')).ok);
      plies++;
    }
  }
});

test('status reports the winner by disc majority when neither side can move', () => {
  const e = createOthello();
  // Fill the board entirely with Black → over, Black wins 64–0.
  assert.ok(e.deserialize('b'.repeat(64) + 'w'));
  const st = e.status();
  assert.equal(st.over, true);
  assert.equal(st.winner, 'b');
  assert.deepEqual(st.counts, { b: 64, w: 0 });
  assert.match(st.reason, /Black wins 64–0/);
});

test('serialize/deserialize round-trips; a malformed token is rejected', () => {
  const e = createOthello();
  e.move({ r: 2, c: 3 }); e.move({ r: 2, c: 2 });
  const tok = e.serialize();
  assert.equal(tok.length, 65);
  const e2 = createOthello();
  assert.ok(e2.deserialize(tok));
  assert.equal(e2.serialize(), tok);
  assert.equal(e2.deserialize('too short'), false);
  assert.equal(e2.deserialize('x'.repeat(64) + 'b'), false); // bad cell char
});

test('the AI always returns one of the current legal moves', () => {
  const e = createOthello();
  for (const level of ['easy', 'medium', 'hard']) {
    const legal = new Set(e.legalMoves().map((m) => `${m.r},${m.c}`));
    const m = e.aiMove(level);
    assert.ok(m && legal.has(`${m.r},${m.c}`), `${level} AI returned an illegal move`);
  }
});

test('a full self-played AI game terminates and ends over', () => {
  const e = createOthello();
  let plies = 0;
  while (!e.status().over && plies < 80) {
    const m = e.aiMove('medium');
    if (!m) break;
    assert.ok(e.move(m).ok);
    plies++;
  }
  assert.equal(e.status().over, true, 'game did not reach a terminal position');
});
