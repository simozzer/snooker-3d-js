// t_miss_freeball.test.js — integration of the new snooker rules through game.js/the variant geometry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snooker } from '../src/variants/snooker.js';
import { newGame, takeShot } from '../src/game.js';

test('canHitBallOn: clear line to a red is true; a ball in the corridor blocks it', () => {
  const frame = snooker.newFrame(); frame.reds = 1; frame.ballInHand = false;
  const state = {
    variant: snooker, frame,
    pieces: [
      { id: 'cue', color: 'cue', kind: 'cue', pos: { x: -0.5, y: 0 } },
      { id: 'red1', color: 'red', kind: 'red', pos: { x: 0.5, y: 0 } },
    ],
  };
  assert.equal(snooker.canHitBallOn(state, { x: -0.5, y: 0 }), true, 'clear line to the red');
  state.pieces.push({ id: 'blue', color: 'blue', kind: 'colour', pos: { x: 0, y: 0 } }); // blocker in the corridor
  assert.equal(snooker.canHitBallOn(state, { x: -0.5, y: 0 }), false, 'blocked → snookered on the reds');
});

test('takeShot flags a miss and returns a pre-shot snapshot when the cue hits nothing it could have', () => {
  const g = newGame(snooker, { jitter: 0 });
  // From the D, a soft shot into the baulk cushion contacts no red — but the reds WERE reachable.
  const res = takeShot(g, { angle: Math.PI, speed: 1.5 });
  assert.equal(res.outcome.foul, true, 'hitting no ball is a foul');
  assert.equal(res.outcome.miss, true, 'could have hit a red from the D → a miss');
  assert.ok(res.preShot && Array.isArray(res.preShot.pieces) && res.preShot.frame, 'a recall snapshot is returned');
});

test('the free-ball award condition: a foul leaving the incoming player snookered on the red', () => {
  // The incoming player, playing from where the cue rests, has a colour blocking the only red → snookered.
  // game.js awards a free ball exactly when (outcome.foul && !ballInHand && !canHitBallOn) holds.
  const state = { variant: snooker, frame: snooker.newFrame(), pieces: [
    { id: 'cue', color: 'cue', kind: 'cue', pos: { x: 0, y: 0 } },
    { id: 'red1', color: 'red', kind: 'red', pos: { x: 0.6, y: 0 } },
    { id: 'blue', color: 'blue', kind: 'colour', pos: { x: 0.3, y: 0 } }, // blocks the cue→red line
  ] };
  state.frame.reds = 1; state.frame.ballInHand = false;
  assert.equal(snooker.canHitBallOn(state, { x: 0, y: 0 }), false, 'snookered on the red → free ball would be awarded');
});

test('HUD text reflects free ball and the re-spotted black', () => {
  const f = snooker.newFrame(); f.reds = 5; f.freeBall = true;
  assert.match(snooker.centerText(f), /FREE BALL/);
  assert.match(snooker.turnGoal(f), /free ball/i);
  const f2 = snooker.newFrame(); f2.reds = 0; f2.respottedBlack = true;
  for (const c of ['yellow', 'green', 'brown', 'blue', 'pink']) f2.colours[c] = false;
  assert.match(snooker.centerText(f2), /RE-SPOTTED BLACK/);
  assert.match(snooker.turnGoal(f2), /win/i);
});
