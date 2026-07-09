// dice.test.js — unit tests for the DOM-free Dice (Farkle) engine (src/board/dice.js). Every roll is
// fed explicit values so the RULES — scoring, the 350-to-bank threshold, farkles, hot dice, three-
// strike penalty and win detection — are what's under test, never chance.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDice, scoreCount, scoreSelection, MIN_BANK, TARGET } from '../src/board/dice.js';

test('scoreCount: singles, triples and the doubling beyond a triple', () => {
  assert.equal(scoreCount(1, 1), 100);
  assert.equal(scoreCount(5, 1), 50);
  assert.equal(scoreCount(1, 2), 200);
  assert.equal(scoreCount(1, 3), 1000);
  assert.equal(scoreCount(1, 4), 2000);
  assert.equal(scoreCount(1, 6), 8000);
  assert.equal(scoreCount(5, 3), 750);
  assert.equal(scoreCount(5, 6), 6000);
  // faces 2,3,4,6 only score as a triple-or-better; face×100 then doubled each extra die
  assert.equal(scoreCount(2, 2), 0);
  assert.equal(scoreCount(2, 3), 200);
  assert.equal(scoreCount(3, 3), 300);
  assert.equal(scoreCount(4, 4), 800);
  assert.equal(scoreCount(6, 6), 4800);
});

test('scoreSelection sums the per-face scores of a mixed keep', () => {
  assert.equal(scoreSelection([1, 5]), 150);
  assert.equal(scoreSelection([1, 1, 1, 5]), 1050);
  assert.equal(scoreSelection([2, 2, 2]), 200);
  assert.equal(scoreSelection([3, 4, 6]), 0); // three non-matching, non-1/5 dice score nothing
});

test('eligibility: only 1s, 5s and members of a triple can be set aside', () => {
  const g = createDice();
  g.newGame(['A', 'B']);
  g.roll([1, 5, 2, 2, 2, 3]); // 1 and 5 score; the three 2s form a triple; the lone 3 does not
  assert.equal(g.eligible(0), true);  // 1
  assert.equal(g.eligible(1), true);  // 5
  assert.equal(g.eligible(2), true);  // 2 (in triple)
  assert.equal(g.eligible(3), true);
  assert.equal(g.eligible(4), true);
  assert.equal(g.eligible(5), false); // lone 3
});

test('a full turn: roll, set aside, roll on, then bank credits the player and passes on', () => {
  const g = createDice();
  g.newGame(['A', 'B']);
  g.roll([1, 1, 1, 2, 3, 4]);        // three 1s = 1000
  g.toggleSelect(0); g.toggleSelect(1); g.toggleSelect(2);
  assert.equal(g.selectionScore(), 1000);
  assert.equal(g.canBank(), true);
  assert.equal(g.canRoll(), true);
  g.rollAgain([5, 2, 3]);            // three live dice re-rolled; a 5 keeps it alive
  assert.equal(g.state().turnScore, 1000);
  assert.equal(g.isFarkle(), false);
  g.toggleSelect(3);                 // the 5 (index 3 was a live die)
  assert.equal(g.selectionScore(), 50);
  const res = g.bank();
  assert.deepEqual(res, { banked: true, won: false });
  assert.equal(g.state().players[0].score, 1050);
  assert.equal(g.state().current, 1, 'turn passed to player B');
});

test('the 350 minimum blocks banking a small turn but still allows rolling on', () => {
  const g = createDice();
  g.newGame(['A', 'B']);
  g.roll([5, 2, 3, 4, 6, 2]);        // only the single 5 (50) scores
  g.toggleSelect(0);
  assert.equal(g.selectionScore(), 50);
  assert.equal(g.canRoll(), true, 'can always roll on with a scoring die set aside');
  assert.equal(g.canBank(), false, 'but 50 < 350 so cannot bank yet');
});

test('farkle wipes the turn score and endFarkle passes to the next player', () => {
  const g = createDice();
  g.newGame(['A', 'B']);
  g.roll([1, 1, 1, 2, 2, 2]);        // 1000 + a triple of 2s available
  g.toggleSelect(0); g.toggleSelect(1); g.toggleSelect(2);
  const r = g.rollAgain([2, 3, 4]);  // three live dice: no 1/5, no triple -> farkle
  assert.equal(r.farkle, true);
  assert.equal(g.isFarkle(), true);
  assert.equal(g.state().turnScore, 0, 'the built-up 1000 is lost');
  g.endFarkle();
  assert.equal(g.state().current, 1);
  assert.equal(g.state().players[0].strikes, 1);
});

test('hot dice: setting all six aside rolls a fresh six and keeps the turn going', () => {
  const g = createDice();
  g.newGame(['A', 'B']);
  g.roll([1, 1, 1, 5, 5, 5]);        // 1000 + 750 = 1750, all six score
  for (let i = 0; i < 6; i++) g.toggleSelect(i);
  assert.equal(g.selectionScore(), 1750);
  const r = g.rollAgain([1, 2, 3, 4, 6, 3]); // hot dice: all six roll afresh
  assert.equal(r.farkle, false);
  assert.equal(g.state().turnScore, 1750, 'turn total carries across the hot-dice reroll');
  assert.equal(g.state().dice.filter((d) => d.held).length, 0, 'the six are live again');
});

test('three farkles in a row costs 1000 points and resets the strike count', () => {
  const g = createDice();
  g.newGame(['A', 'B']);
  // Give A a bank first so the penalty has something to bite into.
  g.roll([1, 1, 1, 5, 5, 3]);
  g.toggleSelect(0); g.toggleSelect(1); g.toggleSelect(2); g.toggleSelect(3); g.toggleSelect(4);
  g.bank();                          // A: 1000+100 = 1100, now B's turn
  assert.equal(g.state().players[0].score, 1100);

  const farkleFor = (idx) => {
    // whoever's up rolls a dud and passes
    g.roll([2, 3, 4, 6, 3, 2]);
    assert.equal(g.isFarkle(), true);
    g.endFarkle();
  };
  // A and B each need to be the one farkling; drive A to 3 strikes by farkling on A's turns.
  // Current player is B. Farkle B, then A, alternating; count A's strikes to 3.
  let aStrikes = 0, guard = 0;
  while (aStrikes < 3 && guard++ < 20) {
    const cur = g.state().current;
    farkleFor(cur);
    aStrikes = g.state().players[0].strikes;
    if (g.state().players[0].score < 1100) break; // penalty applied
  }
  assert.equal(g.state().players[0].score, 100, '1100 - 1000 penalty after three A farkles');
  assert.equal(g.state().players[0].strikes, 0, 'strikes reset after the penalty');
});

test('reaching the target ends the game and names the winner', () => {
  const g = createDice();
  g.newGame(['A', 'B']);
  // Bank repeatedly for A until at/over TARGET. Each big turn banks 8000 (six 1s) — one is plenty.
  g.roll([1, 1, 1, 1, 1, 1]);        // 8000, well past TARGET
  for (let i = 0; i < 6; i++) g.toggleSelect(i);
  assert.equal(g.selectionScore(), 8000);
  const res = g.bank();
  assert.equal(res.banked, true);
  assert.equal(res.won, true);
  const s = g.state();
  assert.equal(s.phase, 'over');
  assert.equal(s.winner, 0);
  assert.ok(s.players[0].score >= TARGET);
});

test('constants are exported and sane', () => {
  assert.equal(MIN_BANK, 350);
  assert.ok(TARGET >= MIN_BANK);
});
