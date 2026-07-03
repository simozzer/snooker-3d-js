// trickshots.test.js — the guarantee that every Trick Shots level is beatable. For each curated famous
// shot and a sweep of generated levels, findSolution must return a stroke, and REPLAYING that stroke
// through the engine must actually satisfy the level's goal. Also checks the two signature mechanics —
// a cue-stick bank and a jump — really occur, so "cues as rails" and jump shots aren't vacuous.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CURATED, CURATED_COUNT, getLevel, generateLevel, findSolution, runTrickShot,
  tableGeom, cueRail, jumped, leapt, bankedOffCue, cueSafe, jumpSeed, ghost,
} from '../src/trickshots.js';

// A solution the searcher returns must, when actually played, meet the goal — no self-deception.
function assertSolvable(level, label) {
  const sol = findSolution(level);
  assert.ok(sol, `${label}: findSolution found no beating stroke`);
  const res = runTrickShot(level, sol);
  assert.ok(level.goal(res), `${label}: the returned stroke did not satisfy the goal`);
  return { sol, res };
}

test('every curated famous shot is solvable, and its solution really wins', () => {
  assert.ok(CURATED.length >= 5, 'expected the famous-shot showcase to be populated');
  for (const level of CURATED) assertSolvable(level, `curated "${level.name}"`);
});

test('"The Leapfrog" leaps cleanly OVER the blocker (never touches it), then pots the 8', () => {
  const g = tableGeom('pool');
  const level = CURATED.find((l) => l.id === 'leapfrog');
  const { res, sol } = assertSolvable(level, 'leapfrog');
  assert.ok(leapt(res, g.R), 'the winning stroke did not rise to a real jump height');
  assert.ok((sol.elevation || 0) > 0.1, `expected an elevated cue, got elevation ${sol.elevation}`);
  assert.ok(!res.cueContacts.includes('blk'), `the cue collided with the blocker: contacts ${JSON.stringify(res.cueContacts)}`);
});

test('the analytic projectile seed jumps clean over the blocker (no elevation sweep)', () => {
  const g = tableGeom('pool');
  // cue, a target with a clear pocket line, and a blocker planted dead on the cue→ghost line
  const P = g.pockets[3].center; // top-right
  const T = { x: P.x - 0.24, y: P.y - 0.18 };
  const C = { x: T.x - 0.9, y: T.y - 0.34 };
  const gh = ghost({ pos: T }, { center: P }, g.R);
  const mid = { x: (C.x + gh.x) / 2, y: (C.y + gh.y) / 2 };
  const pieces = [
    { id: 'cue', color: '#fff', pos: C },
    { id: 'target', color: '#c0241f', pos: T },
    { id: 'blk', color: '#e07b1a', pos: mid },
  ];
  const level = { table: 'pool', pieces, goal: () => true };

  const seed = jumpSeed(g, C, gh, pieces, 'target');
  assert.ok(seed, 'jumpSeed found no blocker to clear');
  assert.ok(seed.elevation > 0.1 && seed.elevation <= Math.PI / 3, `elevation out of range: ${seed.elevation}`);
  assert.ok(seed.speed > 0.5 && seed.speed <= 8, `speed out of range: ${seed.speed}`);

  // Playing the raw analytic seed must leave the bed AND not clip the blocker — i.e. the parabola
  // clears it and the cue's first contact is the target, purely from the closed-form solve.
  const res = runTrickShot(level, { angle: seed.angle, speed: seed.speed, spin: { side: 0, vert: 0 }, elevation: seed.elevation });
  assert.ok(jumped(res), 'the analytic seed did not go airborne');
  assert.notEqual(res.firstContact, 'blk', 'the analytic seed clipped the blocker instead of clearing it');
});

test('"The Guardrail" banks off the laid CUE STICK specifically (not a cushion)', () => {
  const g = tableGeom('pool');
  const level = CURATED.find((l) => l.id === 'guardrail');
  const { res } = assertSolvable(level, 'guardrail');
  assert.ok(bankedOffCue(res, level.rails, g.R), 'the winning stroke never touched the laid cue stick');
});

test('a cue stick laid as a rail actually deflects a ball (physics, not just geometry)', () => {
  const g = tableGeom('pool');
  const rail = cueRail(g, 'x', 0.0, [-0.4, 0.4], 1); // horizontal stick across the middle
  // fire a lone ball straight UP the table into the stick; without the rail it would sail on
  const level = {
    table: 'pool', rails: [rail],
    pieces: [{ id: 'cue', color: '#fff', pos: { x: -0.2, y: -0.35 } }],
    goal: () => true,
  };
  const peakY = (res) => { let p = -Infinity; for (const e of res.timeline) { const b = e.balls.find((x) => x.id === 'cue'); if (b) p = Math.max(p, b.pos.y); } return p; };
  const withRail = peakY(runTrickShot(level, { angle: Math.PI / 2, speed: 3.0 }));
  const withoutRail = peakY(runTrickShot({ ...level, rails: [] }, { angle: Math.PI / 2, speed: 3.0 }));
  // without the stick the ball sails on to the far cushion (~+0.53); with it, it's turned back near y≈0
  assert.ok(withRail < withoutRail - 0.3, `the cue-rail did not turn the ball back (peak with ${withRail.toFixed(3)} vs without ${withoutRail.toFixed(3)})`);
});

test('generated levels across a difficulty sweep are all solvable', () => {
  for (let d = 1; d <= 6; d++) {
    for (const seed of [1, 7]) {
      const level = generateLevel(d, seed);
      assert.ok(level, `difficulty ${d} seed ${seed}: generator returned nothing`);
      assert.ok(level.solution, `difficulty ${d} seed ${seed}: no stored solution`);
      const res = runTrickShot(level, level.solution);
      assert.ok(level.goal(res), `difficulty ${d} seed ${seed}: stored solution does not win`);
    }
  }
});

test('getLevel serves curated shots first, then generated levels', () => {
  const first = getLevel(0);
  assert.equal(first.id, CURATED[0].id, 'level 0 should be the first curated shot');
  const afterCurated = getLevel(CURATED_COUNT);
  assert.ok(afterCurated && afterCurated.generated, 'the level after the curated set should be generated');
  assertSolvable(afterCurated, `getLevel(${CURATED_COUNT})`);
});

test('a solved shot never illegally pots the cue (all goals require a safe cue)', () => {
  for (const level of CURATED) {
    const { res } = assertSolvable(level, level.name);
    assert.ok(cueSafe(res), `${level.name}: winning stroke scratched the cue`);
  }
});
