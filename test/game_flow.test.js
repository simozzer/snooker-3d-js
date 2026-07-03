// game_flow.test.js — game.js orchestration: newGame builds a clean layout, takeShot honours the
// ball-in-hand placement (the shot starts from exactly where you put the cue) and clears the flag, and
// a genuine miss passes the turn. jitter:0 keeps the rack deterministic without an RNG.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newGame, takeShot, buildBalls } from '../src/game.js';
import { pool } from '../src/variants/pool.js';
import { snooker } from '../src/variants/snooker.js';

test('newGame: a fresh frame with a non-overlapping rack and ball-in-hand at the break', () => {
  const game = newGame(pool, { jitter: 0 });
  assert.equal(game.variant, pool);
  assert.equal(game.frame.ballInHand, true);
  const R = pool.ball.radius;
  for (let i = 0; i < game.pieces.length; i++)
    for (let j = i + 1; j < game.pieces.length; j++) {
      const d = Math.hypot(game.pieces[i].pos.x - game.pieces[j].pos.x, game.pieces[i].pos.y - game.pieces[j].pos.y);
      assert.ok(d >= 2 * R * 0.98, 'rack pieces overlap');
    }
});

test('buildBalls maps pieces to engine balls with the variant radius/mass', () => {
  const game = newGame(pool, { jitter: 0 });
  const balls = buildBalls(game.pieces, pool.ball);
  assert.equal(balls.length, game.pieces.length);
  assert.ok(balls.every((b) => b.radius === pool.ball.radius && b.mass === pool.ball.mass));
});

test('takeShot honours cuePlacement: the shot starts exactly where the cue was placed', () => {
  const game = newGame(pool, { jitter: 0 });
  const place = { x: -0.5, y: 0.12 };
  const res = takeShot(game, { angle: Math.PI, speed: 0.6, cuePlacement: place });
  const startCue = res.timeline[0].balls.find((b) => b.id === 'cue');
  assert.ok(Math.abs(startCue.pos.x - place.x) < 1e-9 && Math.abs(startCue.pos.y - place.y) < 1e-9, 'cue did not start at the placement');
  assert.ok(res.timeline.length >= 1 && res.outcome, 'takeShot returns a timeline + outcome');
});

test('a legal break (cue into the pack) consumes ball-in-hand — no foul re-sets it', () => {
  const game = newGame(pool, { jitter: 0 });
  takeShot(game, { angle: 0, speed: 3.5, cuePlacement: { x: -0.5, y: 0 } }); // straight into the apex ball
  assert.equal(game.frame.ballInHand, false, 'a legal contact leaves the frame not owing ball-in-hand');
});

test('a shot that contacts nothing is a foul and passes the turn (pool)', () => {
  const game = newGame(pool, { jitter: 0 });
  // fire the cue from the head area toward the head cushion — nothing between it and the rail
  takeShot(game, { angle: Math.PI, speed: 0.5, cuePlacement: { x: -0.9, y: 0 } });
  assert.equal(game.frame.turn, 1, 'a no-contact foul hands the turn over');
  assert.equal(game.frame.ballInHand, true, 'the opponent gets ball-in-hand');
});

test('snooker: takeShot returns a scored outcome and the frame tracks scores', () => {
  const game = newGame(snooker, { jitter: 0 });
  const res = takeShot(game, { angle: 0, speed: 2, cuePlacement: { x: -0.6, y: 0 } });
  assert.ok(Array.isArray(game.frame.scores) && game.frame.scores.length === 2);
  assert.equal(typeof res.outcome.message, 'string');
});
