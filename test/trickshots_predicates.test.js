// trickshots_predicates.test.js — the goal predicates in isolation, on hand-built engine results. These
// are what decide whether a trick shot "counts", and a subtle bug here (as we hit with jumped() vs
// leapt()) silently ships unbeatable-or-trivial levels. Fast unit coverage, no physics needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  potted, pottedAll, cueSafe, clears, jumped, leapt, comboed,
  bankedBeforeContact, objectBanked, pottedIntoIndex, bankedOffCue,
} from '../src/trickshots.js';

const R = 0.028575;

test('potted / pottedAll / cueSafe / clears', () => {
  const res = { pocketed: ['b1', 'b2'], cleared: [], cueContacts: ['b1', 'blk'] };
  assert.equal(potted(res, 'b1'), true);
  assert.equal(potted(res, 'b9'), false);
  assert.equal(pottedAll(res, ['b1', 'b2']), true);
  assert.equal(pottedAll(res, ['b1', 'b9']), false);
  assert.equal(cueSafe(res), true);
  assert.equal(cueSafe({ pocketed: ['cue'], cleared: [] }), false, 'scratched cue is not safe');
  assert.equal(cueSafe({ pocketed: [], cleared: ['cue'] }), false, 'cleared cue (leapt off) is not safe');
  assert.equal(clears(res, 'blk'), false, 'cue touched blk → not cleared');
  assert.equal(clears(res, 'zzz'), true);
});

test('jumped is loose (any flight), leapt demands a real ≥3R height', () => {
  const flat = { timeline: [{ balls: [{ id: 'cue', pos: { z: R }, phase: 'slide' }] }] };
  assert.equal(jumped(flat), false);
  assert.equal(leapt(flat, R), false);
  const hop = { timeline: [{ balls: [{ id: 'cue', pos: { z: R * 1.01 }, phase: 'flight' }] }] };
  assert.equal(jumped(hop), true, 'a cushion hop registers as jumped()');
  assert.equal(leapt(hop, R), false, 'but a 1.01R hop is NOT a real leap');
  const leap = { timeline: [{ balls: [{ id: 'cue', pos: { z: R * 3.5 }, phase: 'flight' }] }] };
  assert.equal(leapt(leap, R), true, '3.5R clears a ball → a real leap');
});

test('comboed: potted via a DIFFERENT first contact (a plant)', () => {
  assert.equal(comboed({ pocketed: ['target'], firstContact: 'plant' }, 'target'), true);
  assert.equal(comboed({ pocketed: ['target'], firstContact: 'target' }, 'target'), false, 'direct pot is not a combo');
  assert.equal(comboed({ pocketed: [], firstContact: 'plant' }, 'target'), false, 'must actually pot');
});

test('bankedBeforeContact: the cue rails before it touches any object ball', () => {
  const banked = { timeline: [{ kind: 'rail', hit: { id: 'cue' } }, { kind: 'pair', hit: { a: 'cue', b: 'b1' } }] };
  assert.equal(bankedBeforeContact(banked), true);
  const contactFirst = { timeline: [{ kind: 'pair', hit: { a: 'cue', b: 'b1' } }, { kind: 'rail', hit: { id: 'cue' } }] };
  assert.equal(bankedBeforeContact(contactFirst), false);
});

test('objectBanked: the object rails before it drops (a "double")', () => {
  const dbl = { timeline: [{ kind: 'rail', hit: { id: 'b4' } }, { kind: 'pocket', hit: { id: 'b4' } }] };
  assert.equal(objectBanked(dbl, 'b4'), true);
  const straight = { timeline: [{ kind: 'pocket', hit: { id: 'b4' } }] };
  assert.equal(objectBanked(straight, 'b4'), false);
});

test('pottedIntoIndex: which pocket a ball dropped into', () => {
  const res = { timeline: [{ kind: 'pocket', hit: { id: 'b4' }, pocketIndex: 3 }] };
  assert.equal(pottedIntoIndex(res, 'b4'), 3);
  assert.equal(pottedIntoIndex(res, 'b9'), -1);
});

test('bankedOffCue distinguishes a cue-stick bank from a cushion bank', () => {
  const rail = { axis: 'x', perp: 0.1, rc: 0.005, span: [-0.4, 0.4], isCue: true };
  const offStick = { timeline: [{ kind: 'rail', hit: { id: 'cue' }, balls: [{ id: 'cue', pos: { x: 0, y: 0.1 - (R + 0.005) } }] }] };
  assert.equal(bankedOffCue(offStick, [rail], R), true, 'contact point on the laid stick');
  const offCushion = { timeline: [{ kind: 'rail', hit: { id: 'cue' }, balls: [{ id: 'cue', pos: { x: 0, y: -0.5 } }] }] };
  assert.equal(bankedOffCue(offCushion, [rail], R), false, 'far from the stick → a cushion, not the cue');
});
