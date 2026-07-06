// t_rules_extra.test.js — free ball, miss rule, and respotted black (added to the snooker rule core).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newFrame, applyOutcome, ballOn, COLOUR_ORDER, VALUES } from '../src/rules.js';

// --- FREE BALL -------------------------------------------------------------------------------------
test('free ball on a red: nominated colour scores 1, is re-spotted, puts you on a colour', () => {
  const s = newFrame(); s.ballInHand = false; s.freeBall = true;
  const r = applyOutcome(s, { firstContact: 'blue', potted: ['blue'] });
  assert.equal(r.foul, false, 'any first contact is legal on a free ball');
  assert.equal(s.scores[0], VALUES.red, 'free ball is worth the ball-on (a red = 1)');
  assert.equal(s.onColour, true, 'a colour is now on');
  assert.deepEqual(r.respot, ['blue'], 'the nominated colour is re-spotted');
  assert.equal(r.continues, true);
  assert.equal(s.freeBall, false, 'a free ball is spent after one stroke');
  assert.equal(ballOn(s), 'any-colour');
});

test('free ball: potting a ball other than the nominated one is a foul', () => {
  const s = newFrame(); s.ballInHand = false; s.freeBall = true;
  const r = applyOutcome(s, { firstContact: 'blue', potted: ['pink'] }); // hit blue (nominated), potted pink
  assert.equal(r.foul, true);
  assert.equal(s.scores[1], VALUES.pink, 'opponent gets the value of the wrongly-potted ball');
  assert.equal(s.turn, 1);
});

test('free ball while clearing a colour: nominated ball scores the ball-on value, stays on the colour', () => {
  const s = newFrame(); s.ballInHand = false; s.reds = 0;
  for (const c of COLOUR_ORDER) s.colours[c] = c !== 'yellow' ? s.colours[c] : true; // yellow is on
  s.freeBall = true;
  const r = applyOutcome(s, { firstContact: 'black', potted: ['black'] }); // nominate black as a free ball
  assert.equal(r.foul, false);
  assert.equal(s.scores[0], VALUES.yellow, 'scores the value of the ball on (yellow = 2)');
  assert.deepEqual(r.respot, ['black'], 'the free ball is re-spotted');
  assert.equal(ballOn(s), 'yellow', 'still on the lowest colour');
});

// --- MISS RULE -------------------------------------------------------------------------------------
test('miss: a first-contact foul when you COULD have hit the ball-on is flagged as a miss', () => {
  const s = newFrame(); s.ballInHand = false;
  const r = applyOutcome(s, { firstContact: 'black', potted: [], canHitBallOn: true });
  assert.equal(r.foul, true);
  assert.equal(r.miss, true, 'could have hit a red but hit black → miss');
  assert.equal(s.scores[1], VALUES.black);
});

test('not a miss when snookered (could not hit the ball-on)', () => {
  const s = newFrame(); s.ballInHand = false;
  const r1 = applyOutcome(s, { firstContact: 'black', potted: [], canHitBallOn: false });
  assert.equal(r1.foul, true);
  assert.equal(r1.miss, false, 'snookered → not a miss');
  const s2 = newFrame(); s2.ballInHand = false;
  const r2 = applyOutcome(s2, { firstContact: null, potted: [], canHitBallOn: false });
  assert.equal(r2.miss, false, 'hitting nothing while snookered is a foul but not a miss');
});

test('a legal shot is never a miss', () => {
  const s = newFrame(); s.ballInHand = false;
  const r = applyOutcome(s, { firstContact: 'red', potted: ['red'], canHitBallOn: true });
  assert.equal(r.foul, false);
  assert.equal(r.miss, false);
});

// --- RESPOTTED BLACK -------------------------------------------------------------------------------
function onlyBlack(scores) {
  const s = newFrame(); s.ballInHand = false; s.reds = 0;
  for (const c of COLOUR_ORDER) s.colours[c] = c === 'black';
  s.scores = scores;
  return s;
}

test('a frame that finishes level re-spots the black for a decider instead of tying', () => {
  const s = onlyBlack([50, 57]); s.turn = 0; // player 0 pots the black to level 57–57
  const r = applyOutcome(s, { firstContact: 'black', potted: ['black'] });
  assert.equal(s.frameOver, false, 'not over — it is a decider');
  assert.equal(s.respottedBlack, true);
  assert.equal(s.colours.black, true, 'black is back on the table');
  assert.deepEqual(r.respot, ['black']);
  assert.equal(s.ballInHand, true, 'ball-in-hand for the decider');
  assert.equal(s.turn, 1, 'opponent of the potter plays first');
  assert.equal(s.scores[0], 57);
});

test('respotted black: potting it wins the frame', () => {
  const s = onlyBlack([57, 57]); s.respottedBlack = true; s.turn = 1;
  const r = applyOutcome(s, { firstContact: 'black', potted: ['black'] });
  assert.equal(s.frameOver, true);
  assert.equal(s.winner, 1);
  assert.ok(/wins the frame/.test(r.message));
});

test('respotted black: a foul loses the frame to the non-offender', () => {
  const s = onlyBlack([57, 57]); s.respottedBlack = true; s.turn = 0;
  const r = applyOutcome(s, { firstContact: null, potted: [], canHitBallOn: true });
  assert.equal(r.foul, true);
  assert.equal(s.frameOver, true);
  assert.equal(s.winner, 1, 'the fouling player loses');
});
