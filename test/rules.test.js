import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newFrame, applyOutcome, ballOn, VALUES, COLOUR_ORDER } from '../src/rules.js';

test('opening ball-on is a red', () => {
  const s = newFrame();
  assert.equal(ballOn(s), 'red');
});

test('potting a red scores 1, puts a colour on, and continues', () => {
  const s = newFrame();
  const r = applyOutcome(s, { firstContact: 'red', potted: ['red'], cuePotted: false });
  assert.equal(s.scores[0], 1);
  assert.equal(s.reds, 14);
  assert.equal(ballOn(s), 'any-colour');
  assert.ok(r.continues);
  assert.equal(s.turn, 0);
});

test('red then colour: colour scores its value and is re-spotted, back to red', () => {
  const s = newFrame();
  applyOutcome(s, { firstContact: 'red', potted: ['red'] });
  const r = applyOutcome(s, { firstContact: 'black', potted: ['black'] });
  assert.equal(s.scores[0], 1 + VALUES.black);
  assert.deepEqual(r.respot, ['black']); // colour goes back up while reds remain
  assert.equal(ballOn(s), 'red');
  assert.ok(r.continues);
});

test('hitting a colour first when on a red is a foul; opponent gets the penalty', () => {
  const s = newFrame();
  const r = applyOutcome(s, { firstContact: 'blue', potted: [] });
  assert.ok(r.foul);
  assert.equal(s.scores[1], VALUES.blue); // max(4, 5) = 5
  assert.equal(s.turn, 1);
});

test('a foul penalty escalates to the highest ball involved', () => {
  const s = newFrame();
  // On a red, the cue strikes the blue (5) FIRST and pots the black (7): the penalty is the max of
  // every wrongly-involved ball — black (7) — not the blue, nor the 4-point floor.
  const r = applyOutcome(s, { firstContact: 'blue', potted: ['black'] });
  assert.ok(r.foul);
  assert.equal(s.scores[1], VALUES.black, 'penalty should be the highest involved ball (7)');
  assert.equal(s.turn, 1);
});

test('a foul penalty never drops below the floor of 4', () => {
  const s = newFrame();
  // On a red, hitting the yellow (2) first is a foul, but the minimum penalty is 4.
  const r = applyOutcome(s, { firstContact: 'yellow', potted: [] });
  assert.ok(r.foul);
  assert.equal(s.scores[1], 4, 'low-value foul still costs the 4-point minimum');
});

test('a missed shot (legal contact, nothing potted) passes the turn', () => {
  const s = newFrame();
  const r = applyOutcome(s, { firstContact: 'red', potted: [] });
  assert.ok(!r.foul);
  assert.ok(!r.continues);
  assert.equal(s.turn, 1);
  assert.equal(s.scores[0], 0);
});

test('cue in-off is a foul and sets ball-in-hand', () => {
  const s = newFrame();
  const r = applyOutcome(s, { firstContact: 'red', potted: ['red'], cuePotted: true });
  assert.ok(r.foul);
  assert.ok(s.ballInHand);
  assert.equal(s.scores[1], 4); // min foul value
  assert.equal(s.turn, 1);
});

test('clearing phase: colours must go in order, scoring and leaving the table', () => {
  const s = newFrame();
  s.reds = 0; // jump to the colours
  assert.equal(ballOn(s), 'yellow');
  const r = applyOutcome(s, { firstContact: 'yellow', potted: ['yellow'] });
  assert.equal(s.scores[0], VALUES.yellow);
  assert.equal(s.colours.yellow, false);
  assert.deepEqual(r.remove, ['yellow']);
  assert.equal(ballOn(s), 'green');
});

test('wrong colour in the clearing phase is a foul and re-spots it', () => {
  const s = newFrame();
  s.reds = 0;
  const r = applyOutcome(s, { firstContact: 'black', potted: ['black'] }); // on yellow
  assert.ok(r.foul);
  assert.deepEqual(r.respot, ['black']);
  assert.equal(s.colours.black, true);
  assert.equal(s.scores[1], VALUES.black); // penalty raised to 7
});

test('potting the final black ends the frame', () => {
  const s = newFrame();
  s.reds = 0;
  for (const c of COLOUR_ORDER) s.colours[c] = c === 'black';
  s.scores = [50, 40];
  const r = applyOutcome(s, { firstContact: 'black', potted: ['black'] });
  assert.ok(s.frameOver);
  assert.equal(s.winner, 0);
  assert.ok(/wins the frame/.test(r.message));
});
