// t_rules_ballon.test.js — ball-on continuity across a break-ending miss.
// Regression: after potting a red then MISSING the nominated colour, the break ends and the incoming
// player is back on a RED (reds still on the table). A bug left `onColour` set across the miss, so the
// opponent was wrongly left on 'any-colour' and could attack any colour (e.g. blue) next.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newFrame, applyOutcome, ballOn } from '../src/rules.js';

test('a missed colour after a red ends the break — incoming player is on a red', () => {
  const s = newFrame();
  s.ballInHand = false;

  // player 0 pots a red → now on a colour, still at the table
  let r = applyOutcome(s, { firstContact: 'red', potted: ['red'], cuePotted: false });
  assert.equal(s.onColour, true);
  assert.equal(ballOn(s), 'any-colour');
  assert.equal(s.turn, 0);
  assert.equal(r.continues, true);

  // player 0 attempts the black and misses (legal contact, pots nothing)
  r = applyOutcome(s, { firstContact: 'black', potted: [], cuePotted: false });
  assert.equal(r.foul, false, 'hitting a colour while on a colour is legal');
  assert.equal(r.continues, false, 'a missed pot ends the turn');
  assert.equal(s.turn, 1, 'turn passes to the opponent');
  assert.equal(s.onColour, false, 'the break is over — onColour must reset');
  assert.equal(ballOn(s), 'red', 'incoming player is on a red while reds remain');
});

test('a missed red simply passes the turn, still on a red', () => {
  const s = newFrame();
  s.ballInHand = false;
  const r = applyOutcome(s, { firstContact: 'red', potted: [], cuePotted: false });
  assert.equal(r.foul, false);
  assert.equal(r.continues, false);
  assert.equal(s.turn, 1);
  assert.equal(ballOn(s), 'red');
});
