// pool.test.js — 8-ball rules, exercised directly through applyOutcome with synthetic shot outcomes
// (firstContact / potted / cuePotted), so the rule logic is covered fast and deterministically without
// hand-authoring physics: open-table group assignment, fouls, continuation, and the 8-ball win/loss.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/variants/pool.js';

const solid = (n = 1) => ({ id: `b${n}`, number: n, group: 'solid', color: '#e7c63b' });
const stripe = (n = 9) => ({ id: `b${n}`, number: n, group: 'stripe', color: '#2156b0' });
const eight = () => ({ id: 'b8', number: 8, group: 'eight', color: '#1a1a1a' });
// a frame with groups already assigned (player 0 = solids), for post-break scenarios
const assigned = ({ solid = 7, stripe = 7, turn = 0 } = {}) => {
  const f = pool.newFrame();
  f.open = false; f.assigned = ['solid', 'stripe']; f.remaining = { solid, stripe }; f.turn = turn; f.ballInHand = false;
  return f;
};

test('newFrame: open table, ball-in-hand, seven of each group', () => {
  const f = pool.newFrame();
  assert.equal(f.open, true);
  assert.equal(f.ballInHand, true);
  assert.equal(f.turn, 0);
  assert.deepEqual(f.remaining, { solid: 7, stripe: 7 });
  assert.equal(f.frameOver, false);
});

test('open table: legally potting a solid assigns you solids, opponent stripes, and you continue', () => {
  const f = pool.newFrame();
  const out = pool.applyOutcome(f, { firstContact: solid(1), potted: [solid(1)], cuePotted: false });
  assert.equal(out.foul, false);
  assert.equal(out.continues, true);
  assert.equal(f.open, false);
  assert.equal(f.assigned[0], 'solid');
  assert.equal(f.assigned[1], 'stripe');
  assert.equal(f.remaining.solid, 6);
  assert.equal(f.turn, 0); // stay at the table
});

test('open table: potting a stripe assigns you stripes', () => {
  const f = pool.newFrame();
  pool.applyOutcome(f, { firstContact: stripe(10), potted: [stripe(10)], cuePotted: false });
  assert.equal(f.assigned[0], 'stripe');
  assert.equal(f.assigned[1], 'solid');
});

test('foul: no ball contacted → opponent gets ball-in-hand, turn passes', () => {
  const f = pool.newFrame();
  const out = pool.applyOutcome(f, { firstContact: null, potted: [], cuePotted: false });
  assert.equal(out.foul, true);
  assert.equal(out.continues, false);
  assert.equal(f.ballInHand, true);
  assert.equal(f.turn, 1);
});

test('foul: scratching the cue is a foul even if a ball was potted', () => {
  const f = pool.newFrame();
  const out = pool.applyOutcome(f, { firstContact: solid(1), potted: [solid(1)], cuePotted: true });
  assert.equal(out.foul, true);
  assert.equal(f.ballInHand, true);
  assert.equal(f.turn, 1);
});

test('foul: hitting the opponent’s group first (once assigned) is a foul', () => {
  const f = assigned(); // player 0 on solids
  const out = pool.applyOutcome(f, { firstContact: stripe(9), potted: [], cuePotted: false });
  assert.equal(out.foul, true);
  assert.equal(f.turn, 1);
  assert.equal(f.ballInHand, true);
});

test('legal pot of your own group: you continue and the count drops', () => {
  const f = assigned({ solid: 5 });
  const out = pool.applyOutcome(f, { firstContact: solid(2), potted: [solid(2)], cuePotted: false });
  assert.equal(out.foul, false);
  assert.equal(out.continues, true);
  assert.equal(f.remaining.solid, 4);
  assert.equal(f.turn, 0);
});

test('a legal shot that pots nothing passes the turn without a foul', () => {
  const f = assigned();
  const out = pool.applyOutcome(f, { firstContact: solid(1), potted: [], cuePotted: false });
  assert.equal(out.foul, false);
  assert.equal(out.continues, false);
  assert.equal(f.turn, 1);
});

test('win: potting the 8 cleanly when on the 8', () => {
  const f = assigned({ solid: 0 }); // group cleared → on the 8
  const out = pool.applyOutcome(f, { firstContact: eight(), potted: [eight()], cuePotted: false });
  assert.equal(f.frameOver, true);
  assert.equal(f.winner, 0);
  assert.equal(out.continues, false);
});

test('loss: potting the 8 early (group not cleared) hands the frame to the opponent', () => {
  const f = assigned({ solid: 3 });
  pool.applyOutcome(f, { firstContact: solid(1), potted: [eight()], cuePotted: false });
  assert.equal(f.frameOver, true);
  assert.equal(f.winner, 1);
});

test('loss: scratching while potting the 8 loses even when on the 8', () => {
  const f = assigned({ solid: 0 });
  pool.applyOutcome(f, { firstContact: eight(), potted: [eight()], cuePotted: true });
  assert.equal(f.frameOver, true);
  assert.equal(f.winner, 1);
});

test('aiLegalFirst: any non-8 on an open table, the 8 is illegal until you’re on it', () => {
  const open = pool.newFrame();
  assert.equal(pool.aiLegalFirst(open, solid(1)), true);
  assert.equal(pool.aiLegalFirst(open, stripe(9)), true);
  assert.equal(pool.aiLegalFirst(open, eight()), false);
  const onEight = assigned({ solid: 0 });
  assert.equal(pool.aiLegalFirst(onEight, eight()), true);
  assert.equal(pool.aiLegalFirst(onEight, solid(1)), false);
});

test('placementLegal + defaultPlacement: the default ball-in-hand spot is legal and clear', () => {
  const state = { pieces: pool.rack(), frame: pool.newFrame() };
  const dp = pool.defaultPlacement(state);
  assert.equal(pool.placementLegal(state, dp.x, dp.y), true);
  // a point on top of an object ball is illegal
  const ball = state.pieces.find((p) => p.id !== 'cue');
  assert.equal(pool.placementLegal(state, ball.pos.x, ball.pos.y), false);
});

test('rack: cue + 15 numbered object balls', () => {
  const r = pool.rack();
  assert.equal(r.length, 16);
  assert.equal(r.filter((p) => p.id === 'cue').length, 1);
  assert.equal(r.filter((p) => p.group === 'eight').length, 1);
});
