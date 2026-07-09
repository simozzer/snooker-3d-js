// dice-ai.js — the gambling brain for the DICE (Farkle) computer players. Farkle is a pure
// push-your-luck game, so a good opponent is all about ONE judgement, made over and over: with this
// much banked-but-unsecured this turn and this many dice left to throw, do I roll again or bank?
//
// The core is exact expected-value analysis. By enumerating all 6^n outcomes of throwing n dice we get
// the true farkle probability p(n) and the average points a throw sets aside e(n). The break-even
// turn total for one more throw is then the classic result
//        roll while   turnScore  <  e(n) · (1 - p(n)) / p(n)
// i.e. keep gambling until the points you'd risk outweigh what another throw is expected to add. Each
// difficulty scales that threshold and layers on game-awareness; the tables are the shared ground
// truth so the tiers differ by TEMPERAMENT, not by knowing different facts.
//
// Pure and headless (no DOM/engine state) so it unit-tests directly; the view feeds it a plain context
// object and applies the 'roll' | 'bank' verdict it returns.

import { scoreCount } from './dice.js';

// Keep-all scorer: given the pip values of a throw, the score and dice count you get by setting aside
// every scoring die (all 1s and 5s, plus any triple-or-better of 2/3/4/6). score 0 ⇒ a farkle.
export function keepAllScore(faces) {
  const counts = [0, 0, 0, 0, 0, 0, 0];
  for (const f of faces) counts[f]++;
  let score = 0, kept = 0;
  for (let f = 1; f <= 6; f++) {
    const c = counts[f];
    if (f === 1 || f === 5) { score += scoreCount(f, c); kept += c; }
    else if (c >= 3) { score += scoreCount(f, c); kept += c; }
  }
  return { score, kept };
}

// Enumerate every throw of n dice (n = 1..6) once, at module load, to get exact p(n) and e(n).
const P_FARKLE = [1, 0, 0, 0, 0, 0, 0]; // index by dice count; [0] unused (guard = certain farkle)
const E_KEEP = [0, 0, 0, 0, 0, 0, 0];
(function buildTables() {
  for (let n = 1; n <= 6; n++) {
    const total = 6 ** n;
    const dice = new Array(n).fill(1);
    let farkles = 0, sum = 0;
    for (let k = 0; k < total; k++) {
      const { score } = keepAllScore(dice);
      if (score === 0) farkles++; else sum += score;
      // odometer over base-6 dice faces
      let i = 0;
      while (i < n) { if (++dice[i] <= 6) break; dice[i] = 1; i++; }
    }
    P_FARKLE[n] = farkles / total;
    E_KEEP[n] = sum / total; // farkles contribute 0 to the average
  }
})();

// n dice left to throw (0 means "hot dice" — a fresh six).
const live = (n) => (n <= 0 ? 6 : Math.min(6, n));

export const farkleProb = (n) => P_FARKLE[live(n)];
export const expectedKeep = (n) => E_KEEP[live(n)];

// Break-even turn total for one more throw with n dice.
function breakEven(n) {
  const p = P_FARKLE[live(n)];
  if (p <= 0) return Infinity; // can't farkle (shouldn't happen for n>=1) → always worth rolling
  return E_KEEP[live(n)] * (1 - p) / p;
}

// The turn total at or above which a given difficulty chooses to bank (with n dice still to throw).
// easy banks the instant it's legal; medium is cautious (undershoots break-even); hard plays it.
export function bankThreshold(n, difficulty) {
  const base = breakEven(n);
  if (difficulty === 'easy') return 0;                 // ⇒ bank as soon as turnScore ≥ minBank
  if (difficulty === 'medium') return Math.min(base * 0.75, 1500);
  return Math.min(base, 4000);                          // hard: full break-even, capped for sanity
}

// The one decision. ctx = { turnScore, diceRemaining, myScore, oppScore, target, minBank }.
// Returns 'roll' or 'bank'.
export function decideRoll(ctx, difficulty = 'medium') {
  const { turnScore, diceRemaining, myScore, oppScore, target, minBank } = ctx;
  const n = live(diceRemaining);

  // You can't bank below the minimum, so there's nothing to lose by rolling — always roll.
  if (turnScore < minBank) return 'roll';

  // Never gamble a win: if banking now reaches the target, take it. (Basic sense — all tiers.)
  if (myScore + turnScore >= target) return 'bank';

  let T = bankThreshold(n, difficulty);

  // Game-state temperament (the sharper players read the scoreboard).
  if (difficulty === 'hard') {
    const behind = myScore < oppScore;
    const oppThreat = oppScore >= target * 0.8;
    const leadingHome = myScore >= target * 0.75 && myScore >= oppScore;
    if (oppThreat && behind) T *= 1.7;          // opponent is closing on the win — throw caution out
    else if (leadingHome) T *= 0.65;            // protect a near-winning lead: bank sooner
  } else if (difficulty === 'medium') {
    if (oppScore >= target * 0.9 && myScore < oppScore) T *= 1.3; // mild catch-up nerve
  }

  return turnScore < T ? 'roll' : 'bank';
}

// A short label the UI can show so the difficulty reads as a personality, not just a knob.
export const AI_STYLE = {
  easy: 'cautious — banks early',
  medium: 'steady — plays the odds',
  hard: 'sharp — gambles and reads the score',
};
