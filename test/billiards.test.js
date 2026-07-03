// billiards.test.js — English Billiards scoring via applyOutcome: cannon (+2), pot red (+3), pot white
// (+2), in-off red (+3) / white (+2), cumulative; any score keeps you at the table, a non-scoring
// stroke passes the turn, potted balls re-spot, and first to the target wins.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { billiards } from '../src/variants/billiards.js';

const red = { id: 'red', color: 'red', kind: 'object' };
const yellow = { id: 'yellow', color: 'yellow', kind: 'object' };

test('newFrame: 0–0, ball-in-hand, target 50', () => {
  const f = billiards.newFrame();
  assert.deepEqual(f.scores, [0, 0]);
  assert.equal(f.target, 50);
  assert.equal(f.ballInHand, true);
  assert.equal(f.turn, 0);
});

test('cannon (cue touches both balls) scores 2 and keeps you at the table', () => {
  const f = billiards.newFrame();
  const out = billiards.applyOutcome(f, { firstContact: red, potted: [], cuePotted: false, cueContacts: [red, yellow] });
  assert.equal(f.scores[0], 2);
  assert.equal(out.continues, true);
  assert.equal(f.turn, 0);
});

test('pot red = 3 (re-spotted); pot white = 2 (re-spotted)', () => {
  let f = billiards.newFrame();
  let out = billiards.applyOutcome(f, { firstContact: red, potted: [red], cuePotted: false, cueContacts: [red] });
  assert.equal(f.scores[0], 3);
  assert.deepEqual(out.respot, ['red']);

  f = billiards.newFrame();
  out = billiards.applyOutcome(f, { firstContact: yellow, potted: [yellow], cuePotted: false, cueContacts: [yellow] });
  assert.equal(f.scores[0], 2);
  assert.deepEqual(out.respot, ['yellow']);
});

test('in-off: cue potted off the red = 3, off the white = 2, and ball-in-hand next', () => {
  let f = billiards.newFrame();
  billiards.applyOutcome(f, { firstContact: red, potted: [], cuePotted: true, cueContacts: [red] });
  assert.equal(f.scores[0], 3);
  assert.equal(f.ballInHand, true);

  f = billiards.newFrame();
  billiards.applyOutcome(f, { firstContact: yellow, potted: [], cuePotted: true, cueContacts: [yellow] });
  assert.equal(f.scores[0], 2);
});

test('scores stack in one stroke: cannon + pot red = 5', () => {
  const f = billiards.newFrame();
  billiards.applyOutcome(f, { firstContact: red, potted: [red], cuePotted: false, cueContacts: [red, yellow] });
  assert.equal(f.scores[0], 5);
});

test('a miss (no contact) passes the turn and is flagged a foul', () => {
  const f = billiards.newFrame();
  const out = billiards.applyOutcome(f, { firstContact: null, potted: [], cuePotted: false, cueContacts: [] });
  assert.equal(out.foul, true);
  assert.equal(out.continues, false);
  assert.equal(f.turn, 1);
  assert.equal(f.scores[0], 0);
});

test('a non-scoring stroke that DID hit a ball passes the turn but isn’t a miss-foul', () => {
  const f = billiards.newFrame();
  const out = billiards.applyOutcome(f, { firstContact: red, potted: [], cuePotted: false, cueContacts: [red] });
  assert.equal(out.foul, false);
  assert.equal(out.continues, false);
  assert.equal(f.turn, 1);
});

test('reaching the target ends the frame with a winner', () => {
  const f = billiards.newFrame(); f.scores = [48, 0];
  billiards.applyOutcome(f, { firstContact: red, potted: [red], cuePotted: false, cueContacts: [red] }); // +3 → 51
  assert.equal(f.frameOver, true);
  assert.equal(f.winner, 0);
});

test('respotPiece returns the requested ball on a clear spot', () => {
  const state = { frame: billiards.newFrame(), pieces: billiards.rack() };
  assert.equal(billiards.respotPiece(state, 'red').color, 'red');
  assert.equal(billiards.respotPiece(state, 'yellow').color, 'yellow');
});

test('rack: cue + red + yellow', () => {
  const r = billiards.rack();
  assert.equal(r.length, 3);
  assert.deepEqual(r.map((p) => p.id).sort(), ['cue', 'red', 'yellow']);
});
