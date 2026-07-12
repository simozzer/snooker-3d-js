// dice-ai.test.js — unit tests for the Farkle gambling brain (src/board/dice-ai.js). The exact odds
// are pinned to known Farkle values, the individual decision rules are checked in isolation, and a
// seeded Monte-Carlo self-play confirms the difficulty tiers are genuinely ordered: a sharper player
// banks more points per turn than a cautious one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32 } from '../src/share.js';
import { farkleProb, expectedKeep, bankThreshold, decideRoll, keepAllScore } from '../src/board/dice-ai.js';

const ctx = (o) => ({ turnScore: 0, diceRemaining: 6, myScore: 1000, oppScore: 1000, target: 5000, minBank: 350, ...o });

test('farkle probabilities are exact for these house rules', () => {
  const approx = (a, b, tol = 0.005) => Math.abs(a - b) < tol;
  // 1..5 dice match textbook Farkle (straights/three-pairs need six dice, so they can't apply here).
  assert.ok(approx(farkleProb(1), 0.6667), `p(1)=${farkleProb(1)}`);
  assert.ok(approx(farkleProb(2), 0.4444), `p(2)=${farkleProb(2)}`);
  assert.ok(approx(farkleProb(3), 0.2778), `p(3)=${farkleProb(3)}`);
  assert.ok(approx(farkleProb(4), 0.1574), `p(4)=${farkleProb(4)}`);
  assert.ok(approx(farkleProb(5), 0.0772), `p(5)=${farkleProb(5)}`);
  // Six dice: HIGHER than textbook Farkle's 0.0231 because this variant doesn't score straights,
  // three-pairs or two-triplets — so more six-dice throws bust. Exact value = 50/1620.
  assert.ok(approx(farkleProb(6), 0.0309), `p(6)=${farkleProb(6)}`);
});

test('farkle risk falls, and expected keep rises, with more dice', () => {
  for (let n = 2; n <= 6; n++) {
    assert.ok(farkleProb(n) < farkleProb(n - 1), `p(${n}) < p(${n - 1})`);
    assert.ok(expectedKeep(n) > expectedKeep(n - 1), `e(${n}) > e(${n - 1})`);
  }
  // hot dice (0) reads as a fresh six
  assert.equal(farkleProb(0), farkleProb(6));
});

test('keepAllScore: keeps every 1/5 and any triple, farkles otherwise', () => {
  assert.deepEqual(keepAllScore([1, 5, 2, 3, 4, 6]), { score: 150, kept: 2 });
  assert.deepEqual(keepAllScore([2, 2, 2, 3, 4, 6]), { score: 200, kept: 3 });
  assert.deepEqual(keepAllScore([1, 1, 1, 5, 5, 5]), { score: 1750, kept: 6 });
  assert.deepEqual(keepAllScore([2, 3, 4, 6, 2, 3]), { score: 0, kept: 0 }); // farkle
});

test('below the bank minimum every tier rolls (nothing to lose)', () => {
  for (const d of ['easy', 'medium', 'hard']) {
    assert.equal(decideRoll(ctx({ turnScore: 300, diceRemaining: 3, minBank: 350 }), d), 'roll');
  }
});

test('a banking win is never gambled away', () => {
  // banking reaches the target → bank, even with a fat threshold and lots of dice
  for (const d of ['easy', 'medium', 'hard']) {
    assert.equal(decideRoll(ctx({ turnScore: 800, diceRemaining: 6, myScore: 4500, target: 5000 }), d), 'bank');
  }
});

test('final round: chase past the leader, banking only once the bank would overtake', () => {
  // needToBeat = the leader's score you must OVERTAKE. Behind or level → keep rolling (a losing bank is
  // worth the same as a farkle); ahead → take the win. Independent of difficulty temperament.
  for (const d of ['easy', 'medium', 'hard']) {
    assert.equal(decideRoll(ctx({ turnScore: 800, myScore: 4000, needToBeat: 5000 }), d), 'roll'); // 4800 < 5000
    assert.equal(decideRoll(ctx({ turnScore: 1000, myScore: 4000, needToBeat: 5000 }), d), 'roll'); // 5000 ties → leader holds → not enough
    assert.equal(decideRoll(ctx({ turnScore: 1100, myScore: 4000, needToBeat: 5000 }), d), 'bank'); // 5100 > 5000 → win
  }
});

test('easy banks the moment it is legal; hard keeps rolling a fat hand', () => {
  const c = ctx({ turnScore: 400, diceRemaining: 6 });
  assert.equal(decideRoll(c, 'easy'), 'bank');   // 400 ≥ minBank → done
  assert.equal(decideRoll(c, 'hard'), 'roll');   // 6 fresh dice, negligible risk → press on
});

test('with two dice left and points on the line, everyone banks', () => {
  const c = ctx({ turnScore: 500, diceRemaining: 2 });
  for (const d of ['easy', 'medium', 'hard']) assert.equal(decideRoll(c, d), 'bank');
});

test('bank thresholds are ordered easy ≤ medium ≤ hard for every dice count', () => {
  for (let n = 1; n <= 6; n++) {
    const e = bankThreshold(n, 'easy'), m = bankThreshold(n, 'medium'), h = bankThreshold(n, 'hard');
    assert.ok(e <= m + 1e-9 && m <= h + 1e-9, `n=${n}: ${e} ≤ ${m} ≤ ${h}`);
  }
});

test('hard reads the scoreboard: chases when the opponent is near the win', () => {
  // A turn total where a neutral hard player would bank, but a desperate one (opponent about to win,
  // us behind) presses on.
  const base = { turnScore: 300, diceRemaining: 3, minBank: 250, target: 5000 };
  const neutral = decideRoll(ctx({ ...base, myScore: 2000, oppScore: 2000 }), 'hard');
  const desperate = decideRoll(ctx({ ...base, myScore: 2000, oppScore: 4300 }), 'hard');
  assert.equal(neutral, 'bank');
  assert.equal(desperate, 'roll');
});

// ---- Monte-Carlo: the tiers must differ in the ways Farkle actually allows -----------------------
//
// Farkle is a plateau game: once a player plays the odds sensibly, gambling MORE only adds variance,
// not wins. So the honest, testable claims are: (1) the timid tier (easy) is clearly the weakest;
// (2) the sensible tiers gamble more and out-score it; (3) hard is never worse than medium. We do NOT
// assert a big hard-over-medium gap — it doesn't exist, and pretending otherwise would be a fake test.

// Play out one turn and return { pts, rolls } — points banked (0 on a farkle) and throws made. Seeded
// RNG → deterministic. Selection is keep-all (as the view does).
function playTurn(rng, difficulty, myScore, oppScore) {
  const rollN = (n) => Array.from({ length: n }, () => 1 + Math.floor(rng() * 6));
  let turnScore = 0, dice = 6, rolls = 0;
  for (;;) {
    const faces = rollN(dice); rolls++;
    const { score, kept } = keepAllScore(faces);
    if (score === 0) return { pts: 0, rolls };   // farkle — lose the turn
    turnScore += score;
    let remaining = dice - kept;
    if (remaining === 0) remaining = 6;          // hot dice
    const action = decideRoll(
      { turnScore, diceRemaining: remaining, myScore, oppScore, target: 5000, minBank: 350 },
      difficulty,
    );
    if (action === 'bank' && turnScore >= 350) return { pts: turnScore, rolls };
    dice = remaining;
  }
}

// A full game to 5000; players alternate, each using its tier's policy (scores drive hard's
// game-awareness). Returns the winning player's index.
function playGame(rng, diffA, diffB) {
  const score = [0, 0]; const diff = [diffA, diffB];
  let p = 0;
  for (let guard = 0; guard < 600; guard++) {
    score[p] += playTurn(rng, diff[p], score[p], score[1 - p]).pts;
    if (score[p] >= 5000) return p;
    p = 1 - p;
  }
  return -1;
}

test('self-play: the sensible tiers out-score — and out-gamble — the timid one', () => {
  const N = 5000;
  const stats = (difficulty) => {
    const rng = mulberry32(20260710);            // same stream for every tier → fair comparison
    let pts = 0, rolls = 0;
    for (let i = 0; i < N; i++) { const r = playTurn(rng, difficulty, 1500, 1500); pts += r.pts; rolls += r.rolls; }
    return { pts: pts / N, rolls: rolls / N };
  };
  const easy = stats('easy'), medium = stats('medium'), hard = stats('hard');
  // both sensible tiers bank clearly more per turn than the timid one ...
  assert.ok(medium.pts > easy.pts + 18, `medium ${medium.pts | 0} ≫ easy ${easy.pts | 0}`);
  assert.ok(hard.pts > easy.pts + 18, `hard ${hard.pts | 0} ≫ easy ${easy.pts | 0}`);
  // ... hard is never worse than medium ...
  assert.ok(hard.pts >= medium.pts - 8, `hard ${hard.pts | 0} not worse than medium ${medium.pts | 0}`);
  // ... and they gamble more (more throws per turn), easy being the most cautious.
  assert.ok(medium.rolls > easy.rolls, `medium rolls ${medium.rolls.toFixed(2)} > easy ${easy.rolls.toFixed(2)}`);
  assert.ok(hard.rolls >= medium.rolls - 0.02, 'hard gambles at least as much as medium');
});

test('head-to-head: easy is the underdog against both stronger tiers', () => {
  const M = 300;
  const winRate = (a, b) => {                     // fraction of games `a` wins, alternating who starts
    let wins = 0;
    for (let i = 0; i < M; i++) {
      const rng = mulberry32(7000 + i);
      const w = i % 2 === 0 ? playGame(rng, a, b) : playGame(rng, b, a);
      if ((i % 2 === 0 && w === 0) || (i % 2 === 1 && w === 1)) wins++;
    }
    return wins / M;
  };
  assert.ok(winRate('medium', 'easy') > 0.54, 'medium should beat easy more often than not');
  assert.ok(winRate('hard', 'easy') > 0.54, 'hard should beat easy more often than not');
});
