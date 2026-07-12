// dice.js — a DOM-free engine for DICE, the push-your-luck game this compendium's original stand-alone
// version grew from. It's the "house rules" the project's author was taught (350 to get on the board,
// a three-strike penalty) — Farkle-style, but not textbook Farkle. Six dice: roll and set aside the
// scoring ones, then decide whether to bank what you've built up or risk it all on another roll. Roll
// nothing scoring and you "farkle": the whole turn's points evaporate. First past the target wins.
//
// Like the other src/board engines this file is pure logic — no DOM, no canvas. The view
// (web/games/dice-view.js) owns all drawing and input and drives this through the small API below.
// Randomness is Math.random by default but every roll accepts explicit values so tests (and the AI's
// what-if reasoning) stay deterministic — the same convention backgammon.js uses.
//
// ---- SCORING (faithful to the original) ------------------------------------------------------
//   single 1 = 100, single 5 = 50 (only 1s and 5s score on their own)
//   three of a kind = face×100  (three 1s = 1000, three 2s = 200, three 5s = 500, …)
//   each die BEYOND the third of the same face DOUBLES that triple: 4-of=×2, 5-of=×4, 6-of=×8
// A die is "scoring-eligible" if it's a 1, a 5, or part of a group of three-or-more of one face in
// the current roll. You must set aside at least one scoring die per roll. Set all six aside and you
// earn "hot dice" — roll all six afresh and keep going.

const NUM_DICE = 6;
export const MIN_BANK = 350;   // a turn must reach this before it can be banked ("get on the board")
export const TARGET = 5000;    // first player to reach this wins
const STRIKE_PENALTY = 1000;   // three farkles in a row costs this many points

// Points for `count` dice all showing `face`. Mirrors the original's score tables exactly.
export function scoreCount(face, count) {
  if (count <= 0) return 0;
  if (face === 1) return [0, 100, 200, 1000, 2000, 4000, 8000][count] || 0;
  if (face === 5) return [0, 50, 100, 750, 1500, 3000, 6000][count] || 0;
  if (count < 3) return 0;                 // 2,3,4,6 only score as a triple or better
  const mult = [0, 0, 0, 1, 2, 4, 8][count] || 0;
  return face * 100 * mult;
}

// Score a flat list of face values as a complete set-aside selection.
export function scoreSelection(faces) {
  const counts = [0, 0, 0, 0, 0, 0, 0];
  for (const f of faces) counts[f]++;
  let total = 0;
  for (let f = 1; f <= 6; f++) total += scoreCount(f, counts[f]);
  return total;
}

const rollDie = () => 1 + Math.floor(Math.random() * 6);

export function createDice() {
  // Each die: { value, held (set aside earlier this turn), picked (selected from the latest roll) }.
  let dice = [];
  let players = [];
  let current = 0;
  let turnScore = 0;                 // points set aside so far this turn (not yet banked)
  let phase = 'await-roll';          // 'await-roll' | 'pick' | 'over'
  let farkled = false;               // last roll produced nothing scoring
  let winner = null;
  // "Last licks": reaching the target doesn't end the game — it starts a final round where every OTHER
  // player gets exactly one more turn to try to beat that score. Removes the go-first advantage.
  let finalRound = false;
  let finalTurnsLeft = 0;            // final turns still to be played before the game concludes
  let finalTrigger = null;          // the seat that reached the target first (holds ties: got there first)

  function freshDice() {
    dice = Array.from({ length: NUM_DICE }, () => ({ value: 0, held: false, picked: false }));
  }

  function startTurn() {
    freshDice();
    turnScore = 0;
    farkled = false;
    phase = 'await-roll';
  }

  // Faces of the dice still in play (not set aside) — the pool the current roll scores against.
  function liveFaces() {
    return dice.filter((d) => !d.held).map((d) => d.value);
  }

  // Count of each face among the live dice, for three-of-a-kind eligibility.
  function liveCounts() {
    const c = [0, 0, 0, 0, 0, 0, 0];
    for (const d of dice) if (!d.held) c[d.value]++;
    return c;
  }

  // Is live die `i` allowed to be set aside? 1s and 5s always; anything else only inside a triple+.
  function eligible(i) {
    const d = dice[i];
    if (!d || d.held || phase !== 'pick') return false;
    if (d.value === 1 || d.value === 5) return true;
    return liveCounts()[d.value] >= 3;
  }

  // Points the currently-picked dice would bank. Partial triples score 0 until completed.
  function selectionScore() {
    return scoreSelection(dice.filter((d) => d.picked).map((d) => d.value));
  }

  // Roll every live die. On the first roll of a turn from a full hand this is all six; after a
  // "hot dice" clear it's all six again; otherwise just the dice not yet set aside.
  function roll(values) {
    if (phase === 'over') return { farkle: false };
    // Hot dice: everything was set aside last roll — clear the board and roll a fresh six.
    if (dice.every((d) => d.held)) freshDice();
    let vi = 0;
    for (const d of dice) {
      if (d.held) continue;
      d.value = values ? values[vi] : rollDie();
      d.picked = false;
      vi++;
    }
    phase = 'pick';
    // Farkle if nothing among the live dice can be set aside.
    farkled = !dice.some((d, i) => eligible(i));
    if (farkled) turnScore = 0;
    return { farkle: farkled };
  }

  function toggleSelect(i) {
    if (!eligible(i)) return false;
    dice[i].picked = !dice[i].picked;
    return true;
  }

  function canRoll() {
    return phase === 'pick' && !farkled && selectionScore() > 0;
  }

  function canBank() {
    return canRoll() && turnScore + selectionScore() >= MIN_BANK;
  }

  // Set aside the current selection, then roll on. Returns { farkle }.
  function rollAgain(values) {
    if (!canRoll()) return { farkle: false };
    turnScore += selectionScore();
    for (const d of dice) if (d.picked) { d.held = true; d.picked = false; }
    return roll(values);
  }

  function advance() {
    current = (current + 1) % players.length;
    startTurn();
  }

  // Conclude the game after the final round: the highest score wins; a tie is held by whoever reached
  // the target first (finalTrigger). Sets the winner and ends play.
  function conclude() {
    let best = -Infinity;
    for (const pl of players) if (pl.score > best) best = pl.score;
    winner = (finalTrigger != null && players[finalTrigger].score === best)
      ? finalTrigger
      : players.findIndex((pl) => pl.score === best);
    phase = 'over';
  }

  // Count a turn's end during the final round; conclude once every chaser has answered.
  // Returns true if the game is now over.
  function tickFinalRound() {
    if (!finalRound) return false;
    finalTurnsLeft -= 1;
    if (finalTurnsLeft <= 0) { conclude(); return true; }
    return false;
  }

  // Bank the turn: commit the selection, credit the player, then either start/continue the final round
  // (reaching the target no longer wins outright) or pass the dice on.
  function bank() {
    if (!canBank()) return { banked: false, won: false };
    turnScore += selectionScore();
    for (const d of dice) if (d.picked) { d.held = true; d.picked = false; }
    const p = players[current];
    p.score += turnScore;
    p.strikes = 0;
    // First to reach the target starts the final round; everyone else gets one last turn to beat it.
    if (!finalRound && p.score >= TARGET) {
      finalRound = true;
      finalTrigger = current;
      finalTurnsLeft = players.length - 1;
      advance();
      return { banked: true, won: false, finalRound: true, target: current };
    }
    if (tickFinalRound()) return { banked: true, won: winner === current, over: true };
    advance();
    return { banked: true, won: false };
  }

  // Resolve a farkled roll: lose the turn's points, record a strike (three in a row = penalty), then
  // (during the final round) count the answered turn, else pass to the next player.
  function endFarkle() {
    const p = players[current];
    p.strikes = (p.strikes || 0) + 1;
    if (p.strikes >= 3) { p.score = Math.max(0, p.score - STRIKE_PENALTY); p.strikes = 0; }
    if (tickFinalRound()) return { player: current, over: true };
    advance();
    return { player: current };
  }

  return {
    newGame(names = ['You', 'Computer']) {
      players = names.map((name) => ({ name, score: 0, strikes: 0 }));
      current = 0;
      winner = null;
      finalRound = false; finalTurnsLeft = 0; finalTrigger = null;
      startTurn();
    },
    roll,
    rollAgain,
    toggleSelect,
    bank,
    endFarkle,
    eligible,
    selectionScore,
    canRoll,
    canBank,
    isFarkle: () => farkled,
    liveFaces,
    // A read-only snapshot for the view to render from.
    state() {
      return {
        dice: dice.map((d) => ({ ...d })),
        players: players.map((p) => ({ ...p })),
        current,
        turnScore,
        phase,
        farkled,
        winner,
        finalRound,
        finalTrigger,
        minBank: MIN_BANK,
        target: TARGET,
      };
    },
  };
}
