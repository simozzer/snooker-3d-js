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

// --- final round ("last licks") ---------------------------------------------------------------
// Bank a whole turn from one scoring roll (select every eligible die, then bank) — used to march a
// player toward the target in the tests below.
function bankTurn(g, values) {
  g.roll(values);
  for (let i = 0; i < 6; i++) if (g.eligible(i)) g.toggleSelect(i);
  return g.bank();
}
// Climb both players to 4000, then A banks a fifth 1000 to hit 5000 and trigger the final round.
function toFinalRound() {
  const g = createDice();
  g.newGame(['A', 'B']);
  for (let r = 0; r < 4; r++) { bankTurn(g, [1, 1, 1, 2, 3, 4]); bankTurn(g, [1, 1, 1, 2, 3, 4]); }
  const res = bankTurn(g, [1, 1, 1, 2, 3, 4]); // A → 5000
  return { g, res };
}

test('reaching the target starts a final round instead of ending the game', () => {
  const { g, res } = toFinalRound();
  assert.equal(res.finalRound, true, 'target reached → final round begins');
  const s = g.state();
  assert.notEqual(s.phase, 'over', 'the game does not end immediately');
  assert.equal(s.finalRound, true);
  assert.equal(s.finalTrigger, 0, 'A reached the target first');
  assert.equal(s.current, 1, 'the trailing player gets the last turn');
  assert.equal(s.players[0].score, 5000);
  assert.equal(s.players[1].score, 4000);
});

test('the trailing player wins the final round by overtaking the leader', () => {
  const { g } = toFinalRound();
  const res = bankTurn(g, [1, 1, 1, 1, 2, 3]); // B banks four 1s = 2000 → 6000
  assert.equal(res.over, true);
  const s = g.state();
  assert.equal(s.phase, 'over');
  assert.equal(s.players[1].score, 6000);
  assert.equal(s.winner, 1, 'B overtook and wins');
});

test('an exact tie in the final round is held by whoever reached the target first', () => {
  const { g } = toFinalRound();
  bankTurn(g, [1, 1, 1, 2, 3, 4]); // B banks 1000 → 5000, an exact tie
  const s = g.state();
  assert.equal(s.phase, 'over');
  assert.equal(s.players[1].score, 5000);
  assert.equal(s.winner, 0, 'A got there first, so A holds the tie');
});

test('if the chaser farkles in the final round, the leader wins', () => {
  const { g } = toFinalRound();
  g.roll([2, 3, 4, 6, 3, 2]); // farkle
  assert.equal(g.isFarkle(), true);
  const res = g.endFarkle();
  assert.equal(res.over, true);
  const s = g.state();
  assert.equal(s.phase, 'over');
  assert.equal(s.winner, 0, 'B failed to answer, so A wins');
});

// --- state transfer (online play) -------------------------------------------------------------
// The online netting ships one player's authoritative state() to the peer, who load()s it. A snapshot
// must round-trip exactly, mid-turn detail (held/picked dice, turn score, strikes, final round) and all.
test('load() restores a state() snapshot verbatim, mid-turn detail included', () => {
  const a = createDice();
  a.newGame(['Host', 'Guest']);
  a.roll([1, 1, 1, 5, 2, 3]);           // 1000 + a 5
  a.toggleSelect(0); a.toggleSelect(1); a.toggleSelect(2); // keep the three 1s, leave the 5 live
  const snap = a.state();

  const b = createDice();
  b.newGame(['Host', 'Guest']);
  b.load(snap);
  assert.deepEqual(b.state(), snap, 'the reloaded snapshot matches the original');
  // the reloaded engine sees the same in-flight selection, and plays on identically
  assert.equal(b.selectionScore(), a.selectionScore(), 'the picked-dice selection survives the transfer');
  assert.equal(b.selectionScore(), 1000);
  assert.equal(b.rollAgain([5, 2, 3]).farkle, a.rollAgain([5, 2, 3]).farkle, 'roll-on behaves identically');
  assert.deepEqual(b.state(), a.state(), 'still in lockstep after an identical roll-on');
});

test('load() carries the final round across to the peer', () => {
  const a = createDice();
  a.newGame(['Host', 'Guest']);
  a.load({
    dice: Array.from({ length: 6 }, () => ({ value: 0, held: false, picked: false })),
    players: [{ name: 'Host', score: 5000, strikes: 0 }, { name: 'Guest', score: 4000, strikes: 0 }],
    current: 1, turnScore: 0, phase: 'await-roll', farkled: false, winner: null,
    finalRound: true, finalTurnsLeft: 1, finalTrigger: 0, minBank: 350, target: 5000,
  });
  const s = a.state();
  assert.equal(s.finalRound, true);
  assert.equal(s.finalTurnsLeft, 1);
  assert.equal(s.finalTrigger, 0);
  assert.equal(s.current, 1);
});

test('constants are exported and sane', () => {
  assert.equal(MIN_BANK, 350);
  assert.ok(TARGET >= MIN_BANK);
});
