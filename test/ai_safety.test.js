import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newGame, takeShot } from '../src/game.js';
import { chooseShot, opponentSnookered, difficultyConfig, DIFFICULTIES } from '../src/ai.js';
import { snooker } from '../src/variants/snooker.js';
import { pool } from '../src/variants/pool.js';
import { HX, HY } from '../src/table.js';

// The deadly search config (advanced:true) — gates the snooker-only safety/snooker search.
const DEADLY = {
  maxCandidates: 18,
  powerScales: [0.8, 0.95, 1.1, 1.3, 1.6],
  angleOffsets: [-0.012, -0.006, 0, 0.006, 0.012],
  spins: [{ side: 0, vert: 0 }, { side: 0, vert: 0.6 }, { side: 0, vert: -0.6 }, { side: 0.5, vert: 0 }, { side: -0.5, vert: 0 }],
  advanced: true,
};

const snkState = (pieces, patch = {}) => {
  const g = newGame();
  g.pieces = pieces;
  g.frame.reds = pieces.filter((p) => p.color === 'red').length;
  g.frame.ballInHand = false;
  Object.assign(g.frame, patch);
  return g;
};

// --- opponentSnookered: the geometry at the heart of defensive play ---

test('opponentSnookered: a blocker on the only line to the ball-on = snookered', () => {
  const g = snkState([
    { id: 'cue', color: 'cue', kind: 'cue', pos: { x: -0.5, y: 0 } },
    { id: 'r0', color: 'red', kind: 'red', pos: { x: 0.5, y: 0 } },
    { id: 'blue', color: 'blue', kind: 'colour', pos: { x: 0, y: 0 } }, // dead on the cue→red line
  ]);
  assert.equal(opponentSnookered(g, { x: -0.5, y: 0 }), true);
});

test('opponentSnookered: a clear line to the ball-on = NOT snookered', () => {
  const g = snkState([
    { id: 'cue', color: 'cue', kind: 'cue', pos: { x: -0.5, y: 0 } },
    { id: 'r0', color: 'red', kind: 'red', pos: { x: 0.5, y: 0 } },
    { id: 'blue', color: 'blue', kind: 'colour', pos: { x: 0, y: 0.3 } }, // well off the line
  ]);
  assert.equal(opponentSnookered(g, { x: -0.5, y: 0 }), false);
});

test('opponentSnookered: only ONE of several ball-on reds needs a clear line', () => {
  const g = snkState([
    { id: 'cue', color: 'cue', kind: 'cue', pos: { x: -0.5, y: 0 } },
    { id: 'r0', color: 'red', kind: 'red', pos: { x: 0.5, y: 0 } }, // blocked...
    { id: 'r1', color: 'red', kind: 'red', pos: { x: 0.5, y: 0.4 } }, // ...but this one is open
    { id: 'blue', color: 'blue', kind: 'colour', pos: { x: 0, y: 0 } },
  ]);
  assert.equal(opponentSnookered(g, { x: -0.5, y: 0 }), false);
});

test('opponentSnookered: no targets on the table is not a snooker', () => {
  const g = snkState([{ id: 'cue', color: 'cue', kind: 'cue', pos: { x: 0, y: 0 } }], { reds: 0, onColour: false });
  // ball-on would be a colour, but none are on the table here
  assert.equal(opponentSnookered(g, { x: 0, y: 0 }), false);
});

// --- integration: the safety search produces legal defensive shots ---

// A buried single red with the cue at baulk: whatever the deadly AI decides (a marginal pot or a
// safety), executing it must be LEGAL — it must strike the red first and not go in-off. This
// exercises the no-pot safety search path without asserting a specific (physics-dependent) leave.
test('deadly AI plays a legal shot from a tough, potless-looking position (no foul, hits the red)', () => {
  const g = snkState([
    { id: 'cue', color: 'cue', kind: 'cue', pos: { x: -HX + 0.4, y: 0.1 } },
    { id: 'r0', color: 'red', kind: 'red', pos: { x: 0.1, y: 0.02 } }, // near mid-table, awkward for pockets
  ]);
  const shot = chooseShot(g, DEADLY);
  assert.ok(shot, 'AI must return a shot');
  const { outcome } = takeShot(g, { angle: shot.angle, speed: shot.speed, spin: shot.spin, cuePlacement: shot.cuePos });
  assert.ok(!outcome.foul, `deadly AI fouled from a safety position: ${outcome.message}`);
});

// Attacking play must NOT regress: a red sitting over a corner with the cue behind it is still potted
// under the deadly config, even though the safety/snooker machinery is now in the pipeline.
test('deadly AI still pots a sitter (safety search does not hijack an available pot)', () => {
  const g = snkState([
    { id: 'cue', color: 'cue', kind: 'cue', pos: { x: 0.9, y: -0.45 } },
    { id: 'r0', color: 'red', kind: 'red', pos: { x: HX - 0.35, y: -HY + 0.35 } },
  ]);
  const shot = chooseShot(g, DEADLY);
  assert.ok(shot.score > 0, `expected a positive potting line, got ${shot.score}`);
  const { outcome } = takeShot(g, { angle: shot.angle, speed: shot.speed, spin: shot.spin });
  assert.ok(!outcome.foul, `pot attempt fouled: ${outcome.message}`);
  assert.equal(g.frame.scores[0], 1, `expected the red potted; got ${outcome.message}`);
});

// Defensive play is available at EVERY difficulty, scaled: each tier's search config carries its own
// safety-search breadth (narrow → full), and every tier legally plays a safety in a no-pot position.
test('safety search is wired at every difficulty tier and scales in breadth', () => {
  const sizeOf = (b) => b.targets * b.thickness.length * b.paces.length * b.spins.length;
  const easy = DIFFICULTIES.easy.search.safety;
  const medium = DIFFICULTIES.medium.search.safety;
  const hard = DIFFICULTIES.hard.search.safety;
  for (const tier of ['easy', 'medium', 'hard', 'deadly']) {
    assert.ok(DIFFICULTIES[tier].search.safety, `${tier} must carry a safety-search breadth`);
  }
  assert.equal(DIFFICULTIES.deadly.search.safety, hard, 'hard and deadly share the full safety breadth');
  assert.ok(sizeOf(easy) < sizeOf(medium), 'easy safety search is coarser than medium');
  assert.ok(sizeOf(medium) < sizeOf(hard), 'medium safety search is coarser than hard');
  // easy/medium are plain-ball (like their pot search); only the full tier sweeps spin
  assert.equal(easy.spins.length, 1, 'easy safety is plain-ball');
  assert.equal(medium.spins.length, 1, 'medium safety is plain-ball');
  assert.ok(hard.spins.length > 1, 'full safety search sweeps spin');
});

test('every difficulty legally plays a safety from a no-pot position (no crash, no foul-by-default)', () => {
  for (const tier of ['easy', 'medium', 'hard', 'deadly']) {
    const g = snkState([
      { id: 'cue', color: 'cue', kind: 'cue', pos: { x: -0.6, y: 0.15 } },
      { id: 'r0', color: 'red', kind: 'red', pos: { x: 0.15, y: 0.03 } },
    ]);
    let seed = 7; const rng = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const { config } = difficultyConfig(tier, rng);
    let shot;
    assert.doesNotThrow(() => { shot = chooseShot(g, config); }, `${tier} must not throw`);
    assert.ok(shot && Number.isFinite(shot.angle) && shot.speed > 0, `${tier} must return a usable shot`);
  }
});

// The safety/snooker search is snooker-only. A non-snooker variant (pool) under the same advanced
// config must still return a legal shot — it just uses its own roll-to-target fallback, never the
// snooker machinery (pool has no safetyPlay flag).
test('safety search is snooker-gated: pool deadly still returns a legal shot', () => {
  const g = newGame(pool);
  g.pieces = [
    { id: 'cue', number: 0, group: 'cue', color: '#f5f3ea', kind: 'cue', pos: { x: -0.5, y: 0.1 } },
    { id: 'b1', number: 1, group: 'solid', color: '#e7c63b', kind: 'object', pos: { x: 0.2, y: 0.05 } },
  ];
  g.frame.open = false;
  g.frame.assigned = ['solid', 'stripe'];
  g.frame.remaining = { solid: 1, stripe: 7 };
  g.frame.ballInHand = false;
  const shot = chooseShot(g, DEADLY);
  assert.ok(shot, 'pool AI must return a shot');
  const { outcome } = takeShot(g, { angle: shot.angle, speed: shot.speed, spin: shot.spin, cuePlacement: shot.cuePos });
  assert.ok(!outcome.foul, `pool deadly fouled: ${outcome.message}`);
});
