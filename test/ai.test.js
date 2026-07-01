import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newGame, takeShot } from '../src/game.js';
import { chooseShot, chooseShotGrid, chooseShotFinish } from '../src/ai.js';
import { newFrame } from '../src/rules.js';
import { snooker } from '../src/variants/snooker.js';
import { pool } from '../src/variants/pool.js';
import { nineball } from '../src/variants/nineball.js';
import { billiards } from '../src/variants/billiards.js';
import { HX, HY } from '../src/table.js';

// The deadly search config the renderer uses (web/renderer.js DEADLY_SEARCH). advanced:true gates
// the snooker-only break-building features; no robust block, so the 2-ply look-ahead runs.
const DEADLY = {
  maxCandidates: 18,
  powerScales: [0.8, 0.95, 1.1, 1.3, 1.6],
  angleOffsets: [-0.012, -0.008, -0.004, 0, 0.004, 0.008, 0.012],
  spins: [{ side: 0, vert: 0 }, { side: 0, vert: 0.6 }, { side: 0, vert: -0.6 }, { side: 0.5, vert: 0 }, { side: -0.5, vert: 0 }],
  advanced: true,
};

// With a red sitting in front of a corner pocket and the cue behind it, the AI should find a
// positive-scoring potting line — and executing it through the game must actually pot the red.
test('the AI finds and executes a clear pot', () => {
  const g = newGame();
  g.pieces = [
    { id: 'cue', color: 'cue', kind: 'cue', pos: { x: 0.9, y: -0.45 } },
    { id: 'r0', color: 'red', kind: 'red', pos: { x: HX - 0.35, y: -HY + 0.35 } },
  ];
  g.frame.reds = 1;
  g.frame.ballInHand = false;

  const shot = chooseShot(g);
  assert.ok(shot.score > 0, `AI found no pot (score ${shot.score})`);

  const { outcome } = takeShot(g, { angle: shot.angle, speed: shot.speed, spin: shot.spin });
  assert.ok(!outcome.foul, `AI shot fouled: ${outcome.message}`);
  assert.equal(g.frame.scores[0], 1, `expected a pot; got ${outcome.message}`);
});

// On the opening break (ball-in-hand), the AI returns a legal placement in the D and a shot
// that doesn't immediately foul (it should at least strike a red).
test('the AI plays a legal break', () => {
  const g = newGame();
  const shot = chooseShot(g);
  // cue placement must be in the D region (behind the baulk line, −x side)
  assert.ok(shot.cuePos.x <= 0, 'break cue placed on the baulk side');
  const { outcome } = takeShot(g, { angle: shot.angle, speed: shot.speed, spin: shot.spin, cuePlacement: shot.cuePos });
  assert.ok(!outcome.foul, `break fouled: ${outcome.message}`);
});

// THE worker-pool guarantee: scoring the candidate grid in SLICES across N workers and merging the
// results, then running chooseShotFinish ONCE on the main thread, must pick the exact same shot as
// the single-threaded chooseShot. This is the most regression-prone path (it has a prior bug
// history) and at runtime is the DEFAULT for every non-break deadly move — yet it was only ever
// checked by a throwaway scratchpad script. This pins it permanently.
test('worker-sliced grid + finish equals single-threaded chooseShot', () => {
  const g = newGame();
  // A mid-frame deadly position: a few open reds + the colours on their spots, ball-in-hand FALSE
  // so it is NOT a break (aiBreakShots no-ops unless reds===15 && ballInHand) and the grid path runs.
  const colours = g.pieces.filter((p) => p.kind !== 'red' && p.id !== 'cue');
  g.pieces = [
    { id: 'cue', color: 'cue', kind: 'cue', pos: { x: -0.2, y: 0 } },
    { id: 'r0', color: 'red', kind: 'red', pos: { x: HX - 0.3, y: HY - 0.3 } },
    { id: 'r1', color: 'red', kind: 'red', pos: { x: HX - 0.3, y: -HY + 0.3 } },
    { id: 'r2', color: 'red', kind: 'red', pos: { x: 0.3, y: 0.05 } },
    ...colours,
  ];
  g.frame.reds = 3;
  g.frame.ballInHand = false;
  g.frame.onColour = false;

  const sync = chooseShot(g, DEADLY);

  for (const WORKERS of [1, 3, 4]) {
    const merged = [];
    for (let i = 0; i < WORKERS; i++) {
      merged.push(...chooseShotGrid(g, { ...DEADLY, slice: { workers: WORKERS, index: i } }));
    }
    const single = chooseShotGrid(g, DEADLY);
    assert.equal(merged.length, single.length, `${WORKERS} slices must cover the full grid`);

    const parallel = chooseShotFinish(g, DEADLY, merged);
    assert.ok(sync && parallel, 'both paths must produce a shot');
    assert.equal(parallel.angle, sync.angle, `angle mismatch at ${WORKERS} workers`);
    assert.equal(parallel.speed, sync.speed, `speed mismatch at ${WORKERS} workers`);
    assert.equal(parallel.score, sync.score, `score mismatch at ${WORKERS} workers`);
    assert.deepEqual(parallel.spin, sync.spin, `spin mismatch at ${WORKERS} workers`);
    assert.deepEqual(parallel.cuePos, sync.cuePos, `cuePos mismatch at ${WORKERS} workers`);
  }
});

// Regression guard for the worst bug of the build: the 2-ply look-ahead (cycleBonus) crashed on a
// BALL-IN-HAND position because it rebuilt the pieces from state without ADDING a cue when none was
// on the table ("shot.ballId cue not found"). An integration bug no unit test caught — it only
// surfaced mid-frame. This pins the exact state: deadly + ball-in-hand + reds<15 (so the grid+2-ply
// path runs, not the opening break) + NO cue piece. It must produce a placed shot, not throw.
test('deadly 2-ply on a ball-in-hand position does not throw (cue absent from the table)', () => {
  const g = newGame();
  const colours = g.pieces.filter((p) => p.kind !== 'red' && p.id !== 'cue');
  const reds = g.pieces.filter((p) => p.color === 'red').slice(0, 4);
  g.pieces = [...reds, ...colours]; // deliberately NO cue piece on the table
  g.frame.reds = 4;
  g.frame.ballInHand = true; // e.g. after an in-off foul — not the opening break (reds !== 15)
  g.frame.onColour = false;

  // A trimmed advanced config: still gates the 2-ply (advanced:true + snooker's lookahead2 flag) so
  // cycleBonus runs on the ball-in-hand state — just with a small grid so the guard stays fast.
  const LIGHT_2PLY = { maxCandidates: 6, powerScales: [1.0, 1.3], angleOffsets: [0], spins: [{ side: 0, vert: 0 }, { side: 0, vert: -0.6 }], advanced: true };
  let shot;
  assert.doesNotThrow(() => {
    shot = chooseShot(g, LIGHT_2PLY);
  }, 'ball-in-hand 2-ply must not crash');
  assert.ok(shot && shot.cuePos, 'must return a ball-in-hand cue placement');
  assert.ok(shot.cuePos.x <= 0, 'ball-in-hand placement must be in the baulk-side D');
});

// aiPottedAdjust is the snooker-only hook that makes the AI leave reds on the table (a 147 needs the
// black after EVERY red; potting two reds at once forfeits a black). Load-bearing yet untested.
test('aiPottedAdjust damps multi-red pots and is neutral otherwise', () => {
  const f = newFrame(); // ball-on is red
  const red = (id) => ({ id, color: 'red' });
  assert.equal(snooker.aiPottedAdjust(f, [red('r0')]), 0, 'one red: no adjustment');
  const two = snooker.aiPottedAdjust(f, [red('r0'), red('r1')]);
  const three = snooker.aiPottedAdjust(f, [red('r0'), red('r1'), red('r2')]);
  assert.ok(two < 0, `two reds should be damped, got ${two}`);
  assert.ok(three < two, `three reds should be damped harder than two (${three} vs ${two})`);
  const clearing = newFrame();
  clearing.reds = 0; // ball-on is now a colour, not a red
  assert.equal(snooker.aiPottedAdjust(clearing, [red('r0'), red('r1')]), 0, 'off the red phase: neutral');
});

// The core "only applies for snooker" guarantee: every deadly break-building hook must be absent
// from the other variants, so even with advanced:true their AI keeps the plain behaviour.
test('the deadly break-building hooks are snooker-only', () => {
  for (const variant of [pool, nineball, billiards]) {
    for (const flag of ['playForValue', 'aiPottedAdjust', 'safetyPlay', 'lookahead2', 'aiBreakShots']) {
      assert.equal(variant[flag], undefined, `${flag} leaked onto ${variant.name ?? 'a non-snooker variant'}`);
    }
  }
});
