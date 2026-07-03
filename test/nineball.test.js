// nineball.test.js — 9-ball rules via applyOutcome: strike the lowest ball first, any pot on a legal
// shot continues (combos allowed), win by legally potting the 9, fouls give ball-in-hand, and the 9
// potted on a foul is re-spotted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nineball } from '../src/variants/nineball.js';

const ball = (n) => ({ id: `b${n}`, number: n, group: n === 9 ? 'stripe' : 'solid', color: '#ccc' });

test('newFrame: ball-in-hand, all nine remaining, on the 1', () => {
  const f = nineball.newFrame();
  assert.equal(f.ballInHand, true);
  assert.deepEqual(f.remaining, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(f.turn, 0);
  assert.equal(nineball.centerText(f), 'on: 1');
});

test('foul: not striking the lowest ball first → ball-in-hand to the opponent', () => {
  const f = nineball.newFrame();
  const out = nineball.applyOutcome(f, { firstContact: ball(3), potted: [], cuePotted: false });
  assert.equal(out.foul, true);
  assert.equal(f.ballInHand, true);
  assert.equal(f.turn, 1);
});

test('foul: no contact, and foul: a scratch', () => {
  let f = nineball.newFrame();
  assert.equal(nineball.applyOutcome(f, { firstContact: null, potted: [], cuePotted: false }).foul, true);
  f = nineball.newFrame();
  assert.equal(nineball.applyOutcome(f, { firstContact: ball(1), potted: [], cuePotted: true }).foul, true);
});

test('legal pot: hit the lowest first, pot it, continue; the "on" ball advances', () => {
  const f = nineball.newFrame();
  const out = nineball.applyOutcome(f, { firstContact: ball(1), potted: [ball(1)], cuePotted: false });
  assert.equal(out.foul, false);
  assert.equal(out.continues, true);
  assert.ok(!f.remaining.includes(1));
  assert.equal(nineball.centerText(f), 'on: 2');
});

test('combo: strike the lowest first but pot a higher ball — legal, you continue', () => {
  const f = nineball.newFrame();
  const out = nineball.applyOutcome(f, { firstContact: ball(1), potted: [ball(5)], cuePotted: false });
  assert.equal(out.foul, false);
  assert.equal(out.continues, true);
  assert.ok(!f.remaining.includes(5));
  assert.ok(f.remaining.includes(1));
});

test('a legal shot with no pot passes the turn', () => {
  const f = nineball.newFrame();
  const out = nineball.applyOutcome(f, { firstContact: ball(1), potted: [], cuePotted: false });
  assert.equal(out.continues, false);
  assert.equal(f.turn, 1);
  assert.equal(f.frameOver, false);
});

test('win: legally potting the 9 (combo off the lowest) ends the frame', () => {
  const f = nineball.newFrame();
  const out = nineball.applyOutcome(f, { firstContact: ball(1), potted: [ball(9)], cuePotted: false });
  assert.equal(f.frameOver, true);
  assert.equal(f.winner, 0);
  assert.equal(out.continues, false);
});

test('the 9 potted on a foul is re-spotted, not a win', () => {
  const f = nineball.newFrame();
  const out = nineball.applyOutcome(f, { firstContact: ball(3), potted: [ball(9)], cuePotted: false }); // wrong first ball
  assert.equal(f.frameOver, false);
  assert.equal(out.foul, true);
  assert.deepEqual(out.respot, ['9']);
  assert.ok(f.remaining.includes(9), 'the 9 goes back on the table');
  assert.equal(f.turn, 1);
});

test('aiTargets is exactly the lowest ball on the table', () => {
  const f = nineball.newFrame(); f.remaining = [3, 5, 9];
  const state = { frame: f, pieces: [ball(3), ball(5), ball(9)] };
  const targets = nineball.aiTargets(state);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].number, 3);
});

test('respotPiece returns the 9 on a spot', () => {
  const state = { frame: nineball.newFrame(), pieces: nineball.rack() };
  const rp = nineball.respotPiece(state, '9');
  assert.equal(rp.id, 'b9');
  assert.equal(rp.number, 9);
});

test('rack: cue + nine object balls', () => {
  const r = nineball.rack();
  assert.equal(r.length, 10);
  assert.ok(r.some((p) => p.number === 9));
  assert.equal(r.filter((p) => p.id === 'cue').length, 1);
});
