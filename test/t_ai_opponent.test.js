// t_ai_opponent.test.js — MILESTONE E: the sim-scored AI opponent (aiTurn) driving turn-based
// snooker. Deterministic throughout (a fixed PRNG seeds every noisy decision). The engine, rules,
// and the pre-existing chooseShot are untouched; this exercises the new aiTurn wrapper + difficulty
// model and the coordinator's guarantees (always legal/executable, deterministic, terminates,
// skill-monotonic, plays safe when it can't pot).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newGame, takeShot } from '../src/game.js';
import { newFrame } from '../src/rules.js';
import { snooker } from '../src/variants/snooker.js';
import { aiTurn, DIFFICULTIES } from '../src/ai.js';
import { HX, HY, spots } from '../src/table.js';

// deterministic PRNG (mulberry32)
function rng(seed) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const isShot = (s) =>
  s && Number.isFinite(s.angle) && Number.isFinite(s.speed) && s.speed > 0 &&
  s.spin && Number.isFinite(s.spin.side) && Number.isFinite(s.spin.vert);

// A one-red frame with the cue in play (not the break) so most shots are a plain pot.
function redFrame(cue, red, coloursOnSpots = true) {
  const sp = spots();
  const pieces = [
    { id: 'cue', color: 'white', kind: 'cue', group: 'cue', pos: { ...cue } },
    { id: 'r0', color: 'red', kind: 'red', group: 'red', pos: { ...red } },
  ];
  if (coloursOnSpots) for (const c of ['yellow', 'green', 'brown', 'blue', 'pink', 'black']) pieces.push({ id: c, color: c, kind: 'colour', group: 'colour', pos: { ...sp[c] } });
  const frame = newFrame(); frame.reds = 1; frame.ballInHand = false;
  return { variant: snooker, frame, pieces };
}

// 1. EASY STRAIGHT POT — the AI must choose a shot that pots the ball-on.
test('on an easy straight pot the AI chooses a shot that pots the ball-on', () => {
  // cue at (0,0), red straight up in front of the top-middle pocket
  const g = redFrame({ x: 0, y: 0 }, { x: 0, y: HY - 0.22 });
  const before = g.frame.reds;
  const shot = aiTurn(g, { difficulty: 'hard', rng: rng(1) });
  assert.ok(isShot(shot), 'aiTurn must return a well-formed executable shot');
  takeShot(g, { angle: shot.angle, speed: shot.speed, spin: shot.spin, cuePlacement: shot.cuePlacement });
  assert.ok(g.frame.reds < before, 'the red should be potted (reds decremented)');
  assert.ok(!g.frame.frameOver, 'a single-red pot should not end the frame');
});

// 2. ALWAYS RETURNS A LEGAL, EXECUTABLE SHOT for any non-terminal state (never crash / never null).
test('aiTurn always returns a well-formed executable shot across many random positions × difficulties', () => {
  const r = rng(7);
  const span = (a, b) => a + (b - a) * r();
  for (let i = 0; i < 60; i++) {
    const g = redFrame({ x: span(-HX + 0.1, HX - 0.1), y: span(-HY + 0.1, HY - 0.1) }, { x: span(-HX + 0.1, HX - 0.1), y: span(-HY + 0.1, HY - 0.1) });
    const diff = ['easy', 'medium', 'hard'][i % 3];
    const shot = aiTurn(g, { difficulty: diff, rng: rng(1000 + i) });
    assert.ok(isShot(shot), `case ${i} (${diff}): aiTurn returned a malformed shot ${JSON.stringify(shot)}`);
    // and it must actually run through the engine without throwing
    assert.doesNotThrow(() => takeShot(g, { angle: shot.angle, speed: shot.speed, spin: shot.spin, cuePlacement: shot.cuePlacement }), `case ${i}: shot did not execute`);
  }
});

// 3. NO ILLEGAL (foul) SHOT WHEN A LEGAL POT IS AVAILABLE — a hard AV on a clear pot must not foul.
test('the AI does not foul when a clean legal pot is available in its search (hard)', () => {
  // several unobstructed makeable reds; the hard AI (low noise) should hit the red first, no in-off
  const setups = [
    [{ x: 0, y: 0 }, { x: 0, y: HY - 0.25 }],
    [{ x: -1.2, y: -0.4 }, { x: -1.55, y: -0.65 }],
    [{ x: 1.2, y: 0.4 }, { x: 1.55, y: 0.65 }],
    [{ x: 0.5, y: -0.5 }, { x: 0.9, y: -0.72 }],
  ];
  let clean = 0;
  for (let i = 0; i < setups.length; i++) {
    const g = redFrame(setups[i][0], setups[i][1]);
    const shot = aiTurn(g, { difficulty: 'hard', rng: rng(50 + i) });
    const res = takeShot(g, { angle: shot.angle, speed: shot.speed, spin: shot.spin, cuePlacement: shot.cuePlacement });
    if (!res.outcome.foul) clean += 1;
  }
  assert.ok(clean >= setups.length - 1, `hard AI fouled a makeable pot too often: ${clean}/${setups.length} clean`);
});

// 4. DETERMINISM — same (state, seed, difficulty) → identical chosen shot.
test('same (state, seed, difficulty) gives an identical chosen shot', () => {
  const build = () => redFrame({ x: -0.4, y: 0.1 }, { x: 0.2, y: -0.15 });
  for (const diff of ['easy', 'medium', 'hard']) {
    const a = aiTurn(build(), { difficulty: diff, rng: rng(2024) });
    const b = aiTurn(build(), { difficulty: diff, rng: rng(2024) });
    assert.equal(a.angle, b.angle, `${diff}: angle differs`);
    assert.equal(a.speed, b.speed, `${diff}: speed differs`);
    assert.deepEqual(a.spin, b.spin, `${diff}: spin differs`);
  }
});

// 5. SAFETY — with NO makeable pot, the AI returns a LEGAL shot that contacts the ball-on rather
// than a random hack (no foul when a legal hit is available). Reds-only frame (no colours to
// obstruct), red mid-table off any pocket line, cue with a clear path → no pot, but a clean hit is
// always there. Across several such positions the AI must never foul.
test('with no pot available the AI plays a legal safety (contacts the ball-on, no foul)', () => {
  const setups = [
    [{ x: -0.8, y: 0.1 }, { x: 0.2, y: 0.15 }],
    [{ x: -1.0, y: -0.2 }, { x: 0.5, y: -0.1 }],
    [{ x: 0.9, y: 0.3 }, { x: -0.3, y: 0.35 }],
  ];
  for (let i = 0; i < setups.length; i++) {
    const g = redFrame(setups[i][0], setups[i][1], /* coloursOnSpots */ false); // reds-only: legal hit always available
    const shot = aiTurn(g, { difficulty: 'hard', rng: rng(9 + i) });
    const res = takeShot(g, { angle: shot.angle, speed: shot.speed, spin: shot.spin, cuePlacement: shot.cuePlacement });
    assert.ok(!res.outcome.foul, `pos ${i}: a legal safety exists but the AI fouled: ${res.outcome.events.join(' | ')}`);
  }
});

// 6. AN AI-vs-AI RALLY TERMINATES and obeys the turn/foul rules (no infinite loop). A SHORT frame
// (3 reds) exercises the full break→reds→colours→frame-over cycle quickly; the full 15-red frame is
// the same loop scaled and is validated live, but a small frame keeps the test fast + deterministic.
test('an AI-vs-AI frame terminates and ends with a legal result', () => {
  const r = rng(2026);
  const g = newGame(snooker, { jitter: 0.00025, rng: r });
  // trim to a 3-red frame: remove all but 3 reds and set the counter to match.
  const reds = g.pieces.filter((p) => p.color === 'red');
  const keepIds = new Set(reds.slice(0, 3).map((p) => p.id));
  g.pieces = g.pieces.filter((p) => p.color !== 'red' || keepIds.has(p.id));
  g.frame.reds = 3;
  let turns = 0;
  const CAP = 300;
  while (!g.frame.frameOver && turns < CAP) {
    const shot = aiTurn(g, { difficulty: turns % 2 === 0 ? 'hard' : 'medium', rng: r });
    assert.ok(isShot(shot), `turn ${turns}: malformed AI shot`);
    takeShot(g, { angle: shot.angle, speed: shot.speed, spin: shot.spin, cuePlacement: shot.cuePlacement });
    turns += 1;
  }
  assert.ok(g.frame.frameOver, `frame did not terminate in ${CAP} turns (turns=${turns})`);
  assert.ok(turns < CAP, 'must finish well within the turn cap');
  assert.ok(g.frame.winner === 0 || g.frame.winner === 1 || g.frame.winner === 'tie', 'must declare a legal winner');
  assert.ok(g.frame.reds === 0, 'a finished frame has no reds left');
});

// 7. SKILL MONOTONICITY — hard pots a curated set of makeable positions at a STRICTLY higher rate
// than easy (skill actually matters).
test('hard pots a curated makeable set at a strictly higher rate than easy', () => {
  const positions = [
    [{ x: 0, y: 0 }, { x: 0, y: HY - 0.25 }],
    [{ x: 0, y: 0 }, { x: 0, y: -(HY - 0.25) }],
    [{ x: -1.2, y: -0.4 }, { x: -1.55, y: -0.65 }],
    [{ x: 1.2, y: 0.4 }, { x: 1.55, y: 0.65 }],
    [{ x: -1.0, y: 0 }, { x: -0.5, y: 0 }],
    [{ x: 0.5, y: -0.5 }, { x: 0.9, y: -0.72 }],
  ];
  const potRate = (diff) => {
    let pots = 0; let tot = 0;
    for (let p = 0; p < positions.length; p++) {
      for (let s = 0; s < 8; s++) {
        const g = redFrame(positions[p][0], positions[p][1]);
        const before = g.frame.reds;
        const shot = aiTurn(g, { difficulty: diff, rng: rng(p * 100 + s + 1) });
        takeShot(g, { angle: shot.angle, speed: shot.speed, spin: shot.spin, cuePlacement: shot.cuePlacement });
        if (g.frame.reds < before) pots += 1;
        tot += 1;
      }
    }
    return pots / tot;
  };
  const easy = potRate('easy');
  const medium = potRate('medium');
  const hard = potRate('hard');
  const deadly = potRate('deadly');
  assert.ok(hard > medium && medium > easy, `pot rate not monotonic: easy=${easy.toFixed(2)} medium=${medium.toFixed(2)} hard=${hard.toFixed(2)}`);
  assert.ok(hard - easy > 0.2, `skill gap too small to be meaningful: easy=${easy.toFixed(2)} hard=${hard.toFixed(2)}`);
  assert.ok(deadly >= hard, `deadly must pot at least as well as hard: hard=${hard.toFixed(2)} deadly=${deadly.toFixed(2)}`);
});

// 8. DIFFICULTY NOISE IS MONOTONIC by construction (a sanity check the tiers are ordered).
test('difficulty tiers have monotonically decreasing execution noise', () => {
  assert.ok(DIFFICULTIES.easy.angleErr > DIFFICULTIES.medium.angleErr, 'aim noise should fall easy→medium');
  assert.ok(DIFFICULTIES.medium.angleErr > DIFFICULTIES.hard.angleErr, 'aim noise should fall medium→hard');
  assert.ok(DIFFICULTIES.hard.angleErr > DIFFICULTIES.deadly.angleErr, 'aim noise should fall hard→deadly');
  assert.ok(DIFFICULTIES.deadly.angleErr === 0 && DIFFICULTIES.deadly.speedPct === 0, 'deadly is a perfect hand — zero execution noise');
  assert.ok(DIFFICULTIES.easy.speedPct > DIFFICULTIES.medium.speedPct && DIFFICULTIES.medium.speedPct > DIFFICULTIES.hard.speedPct, 'power noise should fall easy→hard');
  assert.ok(DIFFICULTIES.hard.search.maxCandidates >= DIFFICULTIES.medium.search.maxCandidates, 'search should not narrow with skill');
  assert.ok(DIFFICULTIES.medium.search.maxCandidates >= DIFFICULTIES.easy.search.maxCandidates, 'search should not narrow with skill');
  assert.ok(DIFFICULTIES.deadly.search.maxCandidates >= DIFFICULTIES.hard.search.maxCandidates, 'deadly must search at least as wide as hard');
});

// Regression: the opening break with ball-in-hand AND the cue OFF the table (after a cue in-off, the
// cue is removed and re-spotted in hand). evalBreak must add the cue rather than crash "cue not found".
test('the AI can break with ball-in-hand when the cue is off the table', () => {
  const g = newGame(snooker, { jitter: 0, rng: rng(1) });
  g.pieces = g.pieces.filter((p) => p.id !== 'cue'); // cue potted / not yet placed
  g.frame.ballInHand = true;
  let shot;
  assert.doesNotThrow(() => { shot = aiTurn(g, { difficulty: 'medium', rng: rng(2) }); });
  assert.ok(shot && Number.isFinite(shot.angle) && shot.speed > 0 && shot.cuePlacement, 'returns a legal break shot with a cue placement');
});
